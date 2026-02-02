const core = require("@actions/core");

const { createCheck, getCurrentRunCheckSuiteId } = require("../../src/github/api");
const request = require("../../src/utils/request");
const {
	EVENT_NAME,
	EVENT_PATH,
	FORK_REPOSITORY,
	REPOSITORY,
	REPOSITORY_DIR,
	TOKEN,
	USERNAME,
} = require("./test-constants");
const checkRunsResponse = require("./api-responses/check-runs.json");

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
		core.warning.mockClear();
	});

	test("returns null when `GITHUB_RUN_ID` is missing", async () => {
		const result = await getCurrentRunCheckSuiteId(context);
		expect(result).toBeNull();
		expect(request).not.toHaveBeenCalled();
	});

	test("returns suite id from GitHub Actions run API response", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockResolvedValue({
			data: {
				check_suite_id: 987,
			},
		});

		const result = await getCurrentRunCheckSuiteId(context);
		expect(result).toBe(987);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0]).toBe(
			`${process.env.GITHUB_API_URL}/repos/${context.repository.repoName}/actions/runs/123`,
		);
	});

	test("logs warning and returns null when suite lookup fails", async () => {
		process.env.GITHUB_RUN_ID = "123";
		request.mockRejectedValue(new Error("Request failed"));

		const result = await getCurrentRunCheckSuiteId(context);
		expect(result).toBeNull();
		expect(core.warning).toHaveBeenCalledTimes(1);
		expect(core.warning.mock.calls[0][0]).toContain("Could not resolve check suite");
	});
});
