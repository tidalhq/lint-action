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
 * Sleep helper used by check suite resolution retries.
 * @param {number} ms - Delay duration in milliseconds
 * @returns {Promise<void>}
 */
async function sleep(ms) {
	if (ms <= 0) {
		return;
	}
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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
 * Fetches a check run by full API URL.
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {string} checkRunUrl - Full API URL to a check run
 * @returns {Promise<object>} - Check run response body
 */
async function getCheckRunByUrl(context, checkRunUrl) {
	return request(checkRunUrl, {
		method: "GET",
		headers: getApiHeaders(context),
	});
}

/**
 * Resolves a check suite using a specific workflow job name.
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {string} runId - Workflow run ID
 * @param {string} jobNameHint - Workflow job name hint
 * @param {boolean} debug - Whether to emit debug logs
 * @returns {Promise<number | null>} - Matching check suite ID if found
 */
async function getSuiteIdForJobNameHint(context, runId, jobNameHint, debug) {
	if (!jobNameHint) {
		return null;
	}

	const workflowJobsResponse = await getApi(context, `actions/runs/${runId}/jobs?per_page=100`);
	const jobs = Array.isArray(workflowJobsResponse.data.jobs) ? workflowJobsResponse.data.jobs : [];
	logSuiteDebug(debug, {
		event: "jobs-fetched",
		runId,
		jobNameHint,
		jobCount: jobs.length,
	});

	const matchingJob = jobs.find((job) => job && job.name === jobNameHint);
	if (!matchingJob) {
		logSuiteDebug(debug, {
			event: "job-not-found",
			runId,
			jobNameHint,
			availableJobNames: jobs.map((job) => (job && typeof job.name === "string" ? job.name : "")),
		});
		return null;
	}

	if (!matchingJob.check_run_url) {
		logSuiteDebug(debug, {
			event: "job-missing-check-run-url",
			runId,
			jobNameHint,
			jobId: matchingJob.id || null,
		});
		return null;
	}

	const checkRunResponse = await getCheckRunByUrl(context, matchingJob.check_run_url);
	const jobSuiteId =
		checkRunResponse &&
		checkRunResponse.data &&
		checkRunResponse.data.check_suite &&
		typeof checkRunResponse.data.check_suite.id === "number"
			? checkRunResponse.data.check_suite.id
			: null;

	logSuiteDebug(debug, {
		event: "job-check-run-fetched",
		runId,
		jobNameHint,
		jobSuiteId,
	});

	return jobSuiteId;
}

/**
 * Resolves the check suite ID of the current GitHub Actions workflow run
 * @param {GithubContext} context - Information about the GitHub repository and action trigger event
 * @param {object} [options] - Check suite resolution options
 * @param {string | null} [options.headSha] - SHA of the commit being linted
 * @param {string} [options.mode] - Check suite mode ("auto" or "none")
 * @param {string} [options.jobNameHint] - Job name hint for deterministic suite lookup
 * @param {boolean} [options.debug] - Whether to emit detailed check suite logs
 * @param {number} [options.retries] - Number of resolution attempts
 * @param {number} [options.delayMs] - Delay in milliseconds between retries
 * @returns {Promise<number | null>} - Check suite ID if available
 */
async function getCurrentRunCheckSuiteId(context, options = {}) {
	const {
		headSha = null,
		mode = "auto",
		jobNameHint = "",
		debug = false,
		retries = 6,
		delayMs = 1500,
	} = options;
	const runId = process.env.GITHUB_RUN_ID;
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "";
	const normalizedMode = (mode || "auto").toLowerCase();
	const attempts = Number.isInteger(retries) ? Math.max(retries, 1) : 1;
	const waitDelay = Number.isInteger(delayMs) ? Math.max(delayMs, 0) : 0;

	if (normalizedMode === "none") {
		logSuiteDebug(debug, {
			event: "suite-resolution-disabled",
			mode: normalizedMode,
		});
		return null;
	}

	if (!runId) {
		core.warning("GITHUB_RUN_ID is missing. Creating check runs without check_suite_id.");
		logSuiteDebug(debug, {
			event: "missing-run-id",
			runAttempt,
			headSha,
			jobNameHint,
		});
		return null;
	}

	logSuiteDebug(debug, {
		event: "suite-resolution-start",
		runId,
		runAttempt,
		headSha,
		jobNameHint,
		mode: normalizedMode,
		retries: attempts,
		delayMs: waitDelay,
	});

	let runCandidateSuiteId = null;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		logSuiteDebug(debug, {
			event: "suite-resolution-attempt",
			runId,
			attempt,
			totalAttempts: attempts,
		});

		if (jobNameHint) {
			try {
				const hintedSuiteId = await getSuiteIdForJobNameHint(context, runId, jobNameHint, debug);
				if (hintedSuiteId !== null) {
					core.info(
						`Resolved check suite ${hintedSuiteId} for workflow run ${runId} using job hint "${jobNameHint}".`,
					);
					logSuiteDebug(debug, {
						event: "suite-resolution-success",
						runId,
						attempt,
						resolvedVia: "job-hint",
						checkSuiteId: hintedSuiteId,
					});
					return hintedSuiteId;
				}
			} catch (jobHintError) {
				logSuiteDebug(debug, {
					event: "job-hint-lookup-failed",
					runId,
					attempt,
					errorMessage: jobHintError.message,
				});
			}
		}

		try {
			const workflowRunResponse = await getApi(context, `actions/runs/${runId}`);
			let checkSuiteId = null;
			if (
				workflowRunResponse &&
				workflowRunResponse.data &&
				typeof workflowRunResponse.data.check_suite_id === "number"
			) {
				checkSuiteId = workflowRunResponse.data.check_suite_id;
			}
			if (checkSuiteId !== null) {
				runCandidateSuiteId = checkSuiteId;
			}
			logSuiteDebug(debug, {
				event: "workflow-run-fetched",
				runId,
				attempt,
				checkSuiteId,
			});

			if (checkSuiteId !== null) {
				const suiteChecksResponse = await getApi(context, `check-suites/${checkSuiteId}/check-runs`);
				const suiteCheckRuns = suiteChecksResponse.data.check_runs;
				const hasRunMatch = hasCheckRunForWorkflowRun(runId, suiteCheckRuns);
				if (hasRunMatch) {
					core.info(`Using check suite ${checkSuiteId} for workflow run ${runId}.`);
					logSuiteDebug(debug, {
						event: "suite-resolution-success",
						runId,
						attempt,
						resolvedVia: "run",
						checkSuiteId,
					});
					return checkSuiteId;
				}
				core.info(
					`Check suite ${checkSuiteId} does not match workflow run ${runId}. Attempting fallback lookup.`,
				);
				logSuiteDebug(debug, {
					event: "suite-verification-mismatch",
					runId,
					attempt,
					checkSuiteId,
				});
			}
		} catch (runError) {
			logSuiteDebug(debug, {
				event: "workflow-run-lookup-failed",
				runId,
				attempt,
				errorMessage: runError.message,
			});
		}

		if (headSha) {
			try {
				const commitChecksResponse = await getApi(context, `commits/${headSha}/check-runs`);
				const fallbackSuiteId = getSuiteIdForWorkflowRun(runId, commitChecksResponse.data.check_runs);
				if (fallbackSuiteId !== null) {
					core.info(`Resolved check suite ${fallbackSuiteId} from commit check-runs fallback.`);
					logSuiteDebug(debug, {
						event: "suite-resolution-success",
						runId,
						attempt,
						resolvedVia: "commit-fallback",
						checkSuiteId: fallbackSuiteId,
					});
					return fallbackSuiteId;
				}
			} catch (fallbackError) {
				logSuiteDebug(debug, {
					event: "commit-fallback-failed",
					runId,
					attempt,
					headSha,
					errorMessage: fallbackError.message,
				});
			}
		}

		if (attempt < attempts) {
			logSuiteDebug(debug, {
				event: "suite-resolution-retrying",
				runId,
				nextAttempt: attempt + 1,
				delayMs: waitDelay,
			});
			// Give the checks API time to expose newly-created workflow job metadata.
			await sleep(waitDelay);
		}
	}

	if (runCandidateSuiteId !== null) {
		core.warning(
			`Could not verify check suite for workflow run ${runId}; using run candidate suite ${runCandidateSuiteId} as fallback.`,
		);
		logSuiteDebug(debug, {
			event: "suite-resolution-fallback-candidate",
			runId,
			checkSuiteId: runCandidateSuiteId,
		});
		return runCandidateSuiteId;
	}

	core.warning(
		`Could not resolve check suite for workflow run ${runId}. Falling back to creating check runs without check_suite_id.`,
	);
	logSuiteDebug(debug, {
		event: "suite-resolution-failed",
		runId,
	});
	return null;
}

module.exports = { createCheck, getCurrentRunCheckSuiteId };
