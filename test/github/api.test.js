const core = require("@actions/core");

const { createCheck, getCurrentRunCheckSuiteId } = require("../../src/github/api");
const request = require("../../src/utils/request");
const commitCheckRunsFallbackResponse = require("./api-responses/commit-check-runs-fallback.json");
const checkRunsResponse = require("./api-responses/check-runs.json");
const suiteCheckRunsMatchResponse = require("./api-responses/suite-check-runs-match.json");
const suiteCheckRunsMismatchResponse = require("./api-responses/suite-check-runs-mismatch.json");
const workflowJobCheckRunResponse = require("./api-responses/workflow-job-check-run.json");
const workflowJobsResponse = require("./api-responses/workflow-jobs.json");
const {
	EVENT_NAME,
	EVENT_PATH,
	FORK_REPOSITORY,
	REPOSITORY,
	REPOSITORY_DIR,
	TOKEN,
	USERNAME,
} = require("./test-constants");

jest.mock("../../src/utils/request", () => jest.fn());

describe("createCheck()", () => {
	const LINT_RESULT = {
		isSuccess: true,
		warning: [],
		error: [],
	};
	const context = {
		actor: USERNAME,
		event: {},
		eventName: EVENT_NAME,
		eventPath: EVENT_PATH,
		repository: {
			repoName: REPOSITORY,
			forkName: FORK_REPOSITORY,
			hasFork: false,
		},
		token: TOKEN,
		workspace: REPOSITORY_DIR,
	};

	beforeEach(() => {
		request.mockReset();
		request.mockResolvedValue({
			data: checkRunsResponse,
		});
	});

	test("mocked request should be successful", async () => {
		await expect(
			createCheck("check-name", "sha", context, LINT_RESULT, false, "summary"),
		).resolves.toEqual(undefined);
	});

	test("includes `check_suite_id` in request body when provided", async () => {
		await createCheck("check-name", "sha", context, LINT_RESULT, false, "summary", 42);
		expect(request).toHaveBeenCalledTimes(1);
		const [, options] = request.mock.calls[0];
		expect(options.body.check_suite_id).toBe(42);
	});

	test("omits `check_suite_id` from request body when not provided", async () => {
		await createCheck("check-name", "sha", context, LINT_RESULT, false, "summary");
		expect(request).toHaveBeenCalledTimes(1);
		const [, options] = request.mock.calls[0];
		expect(options.body).not.toHaveProperty("check_suite_id");
	});

	test("mocked request should fail when no lint results are provided", async () => {
		await expect(createCheck("check-name", "sha", context, null, false, "summary")).rejects.toEqual(
			expect.any(Error),
		);
	});
});

describe("getCurrentRunCheckSuiteId()", () => {
	const HEAD_SHA = "abc123";
	const BASE_OPTIONS = {
		headSha: HEAD_SHA,
		retries: 1,
		delayMs: 0,
	};
	const context = {
		actor: USERNAME,
		event: {},
		eventName: EVENT_NAME,
		eventPath: EVENT_PATH,
		repository: {
			repoName: REPOSITORY,
			forkName: FORK_REPOSITORY,
			hasFork: false,
		},
		token: TOKEN,
		workspace: REPOSITORY_DIR,
	};

	afterEach(() => {
		delete process.env.GITHUB_RUN_ID;
		request.mockReset();
		core.info.mockClear();
		core.warning.mockClear();
	});

	test("returns null when `GITHUB_RUN_ID` is missing", async () => {
		const result = await getCurrentRunCheckSuiteId(context);
		expect(result).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	test("returns null when check suite mode is `none`", async () => {
		process.env.GITHUB_RUN_ID = "123";
		const result = await getCurrentRunCheckSuiteId(context, {
			...BASE_OPTIONS,
			mode: "none",
		});
		expect(result).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	test("resolves suite id using job name hint", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: workflowJobsResponse,
		});
		request.mockResolvedValueOnce({
			data: workflowJobCheckRunResponse,
		});

		const result = await getCurrentRunCheckSuiteId(context, {
			...BASE_OPTIONS,
			jobNameHint: "Run linters",
		});

		expect(result).toBe(456);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/actions/runs/123/jobs?per_page=100`,
		);
		expect(request.mock.calls[1][0]).toBe(
			"https://api.github.com/repos/example/example/check-runs/111",
		);
	});

	test("returns suite id when candidate suite matches the current workflow run", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: 987,
			},
		});
		request.mockResolvedValueOnce({
			data: suiteCheckRunsMatchResponse,
		});

		const result = await getCurrentRunCheckSuiteId(context, BASE_OPTIONS);
		expect(result).toBe(987);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/actions/runs/123`,
		);
		expect(request.mock.calls[1][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/check-suites/987/check-runs`,
		);
	});

	test("falls back to commit check runs when candidate suite does not match workflow run", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: 987,
			},
		});
		request.mockResolvedValueOnce({
			data: suiteCheckRunsMismatchResponse,
		});
		request.mockResolvedValueOnce({
			data: commitCheckRunsFallbackResponse,
		});

		const result = await getCurrentRunCheckSuiteId(context, BASE_OPTIONS);
		expect(result).toBe(654);
		expect(request).toHaveBeenCalledTimes(3);
		expect(request.mock.calls[2][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/commits/${HEAD_SHA}/check-runs`,
		);
	});

	test("uses run candidate suite when verification fails after retries", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: 987,
			},
		});
		request.mockRejectedValueOnce(new Error("suite checks unavailable"));
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: 987,
			},
		});
		request.mockResolvedValueOnce({
			data: suiteCheckRunsMismatchResponse,
		});
		request.mockResolvedValueOnce({
			data: {
				check_runs: [],
			},
		});

		const result = await getCurrentRunCheckSuiteId(context, {
			...BASE_OPTIONS,
			retries: 2,
		});

		expect(result).toBe(987);
		expect(core.warning).toHaveBeenCalledTimes(1);
		expect(core.warning.mock.calls[0][0]).toContain("using run candidate suite 987");
	});

	test("retries job hint lookup and resolves on later attempt", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: {
				jobs: [],
			},
		});
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: 987,
			},
		});
		request.mockResolvedValueOnce({
			data: suiteCheckRunsMismatchResponse,
		});
		request.mockResolvedValueOnce({
			data: {
				check_runs: [],
			},
		});
		request.mockResolvedValueOnce({
			data: workflowJobsResponse,
		});
		request.mockResolvedValueOnce({
			data: workflowJobCheckRunResponse,
		});

		const result = await getCurrentRunCheckSuiteId(context, {
			...BASE_OPTIONS,
			retries: 2,
			jobNameHint: "Run linters",
		});

		expect(result).toBe(456);
		expect(request).toHaveBeenCalledTimes(6);
	});

	test("logs warning and returns null when both primary and fallback lookups fail", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: null,
			},
		});
		request.mockResolvedValueOnce({
			data: {
				check_runs: [],
			},
		});
		request.mockResolvedValueOnce({
			data: {
				check_runs: [],
			},
		});
		request.mockResolvedValueOnce({
			data: {
				check_suite_id: null,
			},
		});
		request.mockResolvedValueOnce({
			data: {
				check_runs: [],
			},
		});

		const result = await getCurrentRunCheckSuiteId(context, {
			...BASE_OPTIONS,
			retries: 2,
		});
		expect(result).toBeNull();
		expect(core.warning).toHaveBeenCalledTimes(1);
		expect(core.warning.mock.calls[0][0]).toContain("Could not resolve check suite");
	});
});
