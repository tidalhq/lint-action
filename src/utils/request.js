const https = require("https");

const SENSITIVE_HEADER_KEYS = ["authorization", "token", "cookie", "set-cookie"];

/**
 * Returns headers with sensitive values redacted.
 * @param {object | undefined} headers - Request/response headers
 * @returns {object | undefined} - Sanitized headers
 */
function sanitizeHeaders(headers) {
	if (!headers || typeof headers !== "object") {
		return headers;
	}
	const sanitized = {};
	for (const [key, value] of Object.entries(headers)) {
		const lowerKey = key.toLowerCase();
		const isSensitive = SENSITIVE_HEADER_KEYS.some((sensitiveKey) =>
			lowerKey.includes(sensitiveKey),
		);
		sanitized[key] = isSensitive ? "[redacted]" : value;
	}
	return sanitized;
}

/**
 * Attaches safe request/response context to an error.
 * @param {Error} err - Error object
 * @param {string | URL} url - Request URL
 * @param {object} options - Request options
 * @param {object | undefined} res - HTTP response
 * @returns {Error} - Error with attached context
 */
function attachRequestContext(err, url, options, res) {
	const requestUrl = url && typeof url.toString === "function" ? url.toString() : String(url);
	err.requestInfo = {
		url: requestUrl,
		method: (options && options.method) || "GET",
		headers: sanitizeHeaders(options && options.headers),
	};
	if (res) {
		err.statusCode = res.statusCode;
		err.responseHeaders = sanitizeHeaders(res.headers);
	}
	return err;
}

/**
 * Helper function for making HTTP requests
 * @param {string | URL} url - Request URL
 * @param {object} options - Request options
 * @returns {Promise<object>} - JSON response
 */
function request(url, options) {
	return new Promise((resolve, reject) => {
		const req = https
			.request(url, options, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					if (res.statusCode >= 400) {
						const err = new Error(`Received status code ${res.statusCode}`);
						err.response = res;
						err.data = data;
						attachRequestContext(err, url, options, res);
						reject(err);
					} else {
						resolve({ res, data: JSON.parse(data) });
					}
				});
			})
			.on("error", (err) => {
				attachRequestContext(err, url, options);
				reject(err);
			});
		if (options.body) {
			req.end(JSON.stringify(options.body));
		} else {
			req.end();
		}
	});
}

module.exports = request;
