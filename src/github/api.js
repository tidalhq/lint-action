const core = require("@actions/core");

const { name: actionName } = require("../../package.json");
const request = require("../utils/request");
const { capitalizeFirstLetter } = require("../utils/string");

/** @typedef {import('./context').GithubContext} GithubContext */
/** @typedef {import('../utils/lint-result').LintResult} LintResult */

/**
 * Creates a new check on GitHub which annotates the relevant commit with linting errors
 * @param {string} linterName - Name of the linter for which a check should be created
 * @param {string} sha - SHA of the commit which should be annotated
 * @param {GithubContext} context - Information about the GitHub repository and
 * action trigger event
 * @param {LintResult} lintResult - Parsed lint result
 * @param {boolean} neutralCheckOnWarning - Whether the check run should conclude as neutral if
 * there are only warnings
 * @param {string} summary - Summary for the GitHub check
 * @param {number | null} [checkSuiteId] - ID of the check suite the check run should be attached to
 */
async function createCheck(
	linterName,
	sha,
	context,
	lintResult,
	neutralCheckOnWarning,
	summary,
	checkSuiteId = null,
) {
	let annotations = [];
	for (const level of ["error", "warning"]) {
		annotations = [
			...annotations,
			...lintResult[level].map((result) => ({
				path: result.path,
				start_line: result.firstLine,
				end_line: result.lastLine,
				annotation_level: level === "warning" ? "warning" : "failure",
				message: result.message,
			})),
		];
	}

	// Only use the first 50 annotations (limit for a single API request)
	if (annotations.length > 50) {
		core.info(
			`There are more than 50 errors/warnings from ${linterName}. Annotations are created for the first 50 issues only.`,
		);
		annotations = annotations.slice(0, 50);
	}

	let conclusion;
	if (lintResult.isSuccess) {
		if (annotations.length > 0 && neutralCheckOnWarning) {
			conclusion = "neutral";
		} else {
			conclusion = "success";
		}
	} else {
		conclusion = "failure";
	}

	const body = {
		name: linterName,
		head_sha: sha,
		conclusion,
		output: {
			title: capitalizeFirstLetter(summary),
			summary: `${linterName} found ${summary}`,
			annotations,
		},
	};
	if (checkSuiteId !== null) {
		body.check_suite_id = checkSuiteId;
	}
	try {
		core.info(
			`Creating GitHub check with ${conclusion} conclusion and ${annotations.length} annotations for ${linterName}…`,
		);
		await request(`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/check-runs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// "Accept" header is required to access Checks API during preview period
				Accept: "application/vnd.github.antiope-preview+json",
				Authorization: `Bearer ${context.token}`,
				"User-Agent": actionName,
			},
			body,
		});
		core.info(`${linterName} check created successfully`);
	} catch (err) {
		let errorMessage = err.message;
		if (err.data) {
			try {
				const errorData = JSON.parse(err.data);
				if (errorData.message) {
					errorMessage += `. ${errorData.message}`;
				}
				if (errorData.documentation_url) {
					errorMessage += ` ${errorData.documentation_url}`;
				}
			} catch (e) {
				// Ignore
			}
		}
		core.error(errorMessage);

		throw new Error(`Error trying to create GitHub check for ${linterName}: ${errorMessage}`);
	}
}

/**
 * @param {string} runId - GitHub Actions run ID
 * @param {Array<object> | undefined} checkRuns - Check runs returned by GitHub API
 * @returns {boolean} - Whether any check run belongs to the workflow run
 */
function hasCheckRunForWorkflowRun(runId, checkRuns) {
	if (!Array.isArray(checkRuns)) {
		return false;
	}

	return checkRuns.some((checkRun) => {
		const appSlug = checkRun && checkRun.app ? checkRun.app.slug : "";
		const detailsUrl = (checkRun && (checkRun.details_url || checkRun.html_url)) || "";
		return (
			appSlug === "github-actions" &&
			typeof detailsUrl === "string" &&
			detailsUrl.includes(`/actions/runs/${runId}/`)
		);
	});
}

/**
 * @param {string} runId - GitHub Actions run ID
 * @param {Array<object> | undefined} checkRuns - Check runs returned by GitHub API
 * @returns {number | null} - Matching check suite ID if found
 */
function getSuiteIdForWorkflowRun(runId, checkRuns) {
	if (!Array.isArray(checkRuns)) {
		return null;
	}

	const matchingRun = checkRuns.find((checkRun) => {
		const appSlug = checkRun && checkRun.app ? checkRun.app.slug : "";
		const checkSuiteId =
			checkRun && checkRun.check_suite && typeof checkRun.check_suite.id === "number"
				? checkRun.check_suite.id
				: null;
		const detailsUrl = (checkRun && (checkRun.details_url || checkRun.html_url)) || "";
		return (
			appSlug === "github-actions" &&
			typeof detailsUrl === "string" &&
			detailsUrl.includes(`/actions/runs/${runId}/`) &&
			checkSuiteId !== null
		);
	});

	return matchingRun ? matchingRun.check_suite.id : null;
}

/**
 * Resolves the check suite ID of the current GitHub Actions workflow run
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {string | null} [headSha] - SHA of the commit being linted
 * @returns {Promise<number | null>} - Check suite ID if available
 */
async function getCurrentRunCheckSuiteId(context, headSha = null) {
	const runId = process.env.GITHUB_RUN_ID;
	if (!runId) {
		return null;
	}

	try {
		core.info(`Resolving check suite for workflow run ${runId}…`);
		const { data } = await request(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/actions/runs/${runId}`,
			{
				method: "GET",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${context.token}`,
					"User-Agent": actionName,
				},
			},
		);
		const checkSuiteId = typeof data.check_suite_id === "number" ? data.check_suite_id : null;
		if (checkSuiteId !== null) {
			try {
				const suiteChecksResponse = await request(
					`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/check-suites/${checkSuiteId}/check-runs`,
					{
						method: "GET",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${context.token}`,
							"User-Agent": actionName,
						},
					},
				);

				if (hasCheckRunForWorkflowRun(runId, suiteChecksResponse.data.check_runs)) {
					core.info(`Using check suite ${checkSuiteId} for workflow run ${runId}.`);
					return checkSuiteId;
				}
				core.info(
					`Check suite ${checkSuiteId} does not match workflow run ${runId}. Attempting fallback lookup.`,
				);
			} catch (suiteError) {
				core.info(
					`Could not verify candidate check suite ${checkSuiteId}: ${suiteError.message}. Attempting fallback lookup.`,
				);
			}
		}
	} catch (runError) {
		core.info(
			`Could not resolve candidate check suite from workflow run ${runId}: ${runError.message}. Attempting fallback lookup.`,
		);
	}

	if (headSha) {
		try {
			const commitChecksResponse = await request(
				`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/commits/${headSha}/check-runs`,
				{
					method: "GET",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${context.token}`,
						"User-Agent": actionName,
					},
				},
			);

			const fallbackSuiteId = getSuiteIdForWorkflowRun(runId, commitChecksResponse.data.check_runs);
			if (fallbackSuiteId !== null) {
				core.info(`Resolved check suite ${fallbackSuiteId} from commit check-runs fallback.`);
				return fallbackSuiteId;
			}
		} catch (fallbackError) {
			core.info(
				`Commit check-runs fallback failed for workflow run ${runId}: ${fallbackError.message}.`,
			);
		}
	}

	core.warning(
		`Could not resolve check suite for workflow run ${runId}. Falling back to creating check runs without check_suite_id.`,
	);
	return null;
}

module.exports = { createCheck, getCurrentRunCheckSuiteId };
