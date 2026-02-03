const core = require("@actions/core");

const { createCheck, getCurrentRunCheckSuiteInfo } = require("../../src/github/api");
const request = require("../../src/utils/request");
const checkRunsResponse = require("./api-responses/check-runs.json");
const workflowJobCheckRunResponse = require("./api-responses/workflow-job-check-run.json");
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

	test("logs request metadata and request id on socket errors", async () => {
		const err = new Error("socket hang up");
		err.code = "ECONNRESET";
		err.responseHeaders = { "x-github-request-id": "ABC123" };
		err.requestInfo = {
			url: "https://api.github.com/repos/org/repo/check-runs",
			method: "POST",
			headers: { Authorization: "[redacted]" },
		};
		request.mockRejectedValueOnce(err);

		await expect(
			createCheck("check-name", "sha", context, LINT_RESULT, false, "summary"),
		).rejects.toEqual(expect.any(Error));

		expect(core.error).toHaveBeenCalledWith(
			expect.stringContaining("code: ECONNRESET"),
		);
		expect(core.error).toHaveBeenCalledWith(
			expect.stringContaining("github_request_id=ABC123"),
		);
		expect(core.debug).toHaveBeenCalledWith(expect.stringContaining("[check-run-request]"));
	});
});

describe("getCurrentRunCheckSuiteInfo()", () => {
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
		request.mockReset();
		core.info.mockClear();
		core.warning.mockClear();
	});

	test("returns null when job check run id is missing", async () => {
		const result = await getCurrentRunCheckSuiteInfo(context, { debug: true });
		expect(result).toEqual({ checkSuiteId: null, checkRunHeadSha: null });
		expect(request).not.toHaveBeenCalled();
	});

	test("resolves suite id using job check run id", async () => {
		request.mockResolvedValueOnce({
			data: workflowJobCheckRunResponse,
		});

		const result = await getCurrentRunCheckSuiteInfo(context, {
			jobCheckRunId: 111,
			debug: true,
		});

		expect(result).toEqual({ checkSuiteId: 456, checkRunHeadSha: "abc123" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/check-runs/111`,
		);
		expect(core.info).toHaveBeenCalledWith(expect.stringContaining("[check-suite-debug]"));
	});

	test("warns and returns null when check suite is missing", async () => {
		request.mockResolvedValueOnce({
			data: {},
		});

		const result = await getCurrentRunCheckSuiteInfo(context, {
			jobCheckRunId: 222,
			debug: true,
		});

		expect(result).toEqual({ checkSuiteId: null, checkRunHeadSha: null });
		expect(core.warning).toHaveBeenCalledTimes(1);
		expect(core.warning.mock.calls[0][0]).toContain(
			"Could not resolve check suite from job.check_run_id",
		);
	});

	test("warns and returns null when request fails", async () => {
		request.mockRejectedValueOnce(new Error("boom"));

		const result = await getCurrentRunCheckSuiteInfo(context, {
			jobCheckRunId: 333,
			debug: true,
		});

		expect(result).toEqual({ checkSuiteId: null, checkRunHeadSha: null });
		expect(core.warning).toHaveBeenCalledTimes(1);
		expect(core.warning.mock.calls[0][0]).toContain(
			"Could not resolve check suite from job.check_run_id",
		);
	});
});
