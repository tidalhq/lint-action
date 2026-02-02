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
 * Emits structured check suite diagnostics when debug logging is enabled.
 * @param {boolean} debug - Whether to emit debug logs
 * @param {object} payload - Structured debug payload
 * @returns {void}
 */
function logSuiteDebug(debug, payload) {
	if (!debug) {
		return;
	}
	core.info(`[check-suite-debug] ${JSON.stringify(payload)}`);
}

/**
 * Builds common authenticated GitHub API headers.
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @returns {object} - Authenticated request headers
 */
function getApiHeaders(context) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${context.token}`,
		"User-Agent": actionName,
	};
}

/**
 * Performs an authenticated GET request to a repository-scoped GitHub API path.
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {string} path - Relative API path
 * @returns {Promise<object>} - API response body
 */
async function getApi(context, path) {
	return request(`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/${path}`, {
		method: "GET",
		headers: getApiHeaders(context),
	});
}

/**
 * Resolves the check suite ID of the current GitHub Actions workflow run
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {object} [options] - Check suite resolution options
 * @param {number | null} [options.jobCheckRunId] - Check run ID for the current job
 * @param {boolean} [options.debug] - Whether to emit detailed check suite logs
 * @returns {Promise<number | null>} - Check suite ID if available
 */
async function getCurrentRunCheckSuiteId(context, options = {}) {
	const { jobCheckRunId = null, debug = false } = options;

	if (!Number.isInteger(jobCheckRunId) || jobCheckRunId <= 0) {
		logSuiteDebug(debug, {
			event: "suite-resolution-skipped",
			reason: "missing-job-check-run-id",
		});
		return null;
	}

	logSuiteDebug(debug, {
		event: "suite-resolution-start",
		jobCheckRunId,
	});

	try {
		const checkRunResponse = await getApi(context, `check-runs/${jobCheckRunId}`);
		const checkSuiteId =
			checkRunResponse &&
			checkRunResponse.data &&
			checkRunResponse.data.check_suite &&
			typeof checkRunResponse.data.check_suite.id === "number"
				? checkRunResponse.data.check_suite.id
				: null;

		logSuiteDebug(debug, {
			event: "suite-resolution-result",
			jobCheckRunId,
			checkSuiteId,
		});

		if (checkSuiteId === null) {
			core.warning(
				"Could not resolve check suite from job.check_run_id; creating check runs without check_suite_id.",
			);
		}

		return checkSuiteId;
	} catch (err) {
		logSuiteDebug(debug, {
			event: "suite-resolution-error",
			jobCheckRunId,
			errorMessage: err.message,
		});
		core.warning(
			"Could not resolve check suite from job.check_run_id; creating check runs without check_suite_id.",
		);
		return null;
	}
}

module.exports = { createCheck, getCurrentRunCheckSuiteId };
