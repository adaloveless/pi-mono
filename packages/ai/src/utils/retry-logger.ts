/**
 * Retry error logger — logs retryable errors to both console (screen) and a log file.
 *
 * Browser-safe: file logging is a no-op when Node.js APIs are unavailable.
 * Log file: ~/.pi/logs/retry-errors.log
 */

let _fs: typeof import("node:fs") | null = null;
let _path: typeof import("node:path") | null = null;
let _os: typeof import("node:os") | null = null;

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	Promise.all([import("node:fs"), import("node:path"), import("node:os")]).then(([fs, path, os]) => {
		_fs = fs;
		_path = path;
		_os = os;
	});
}

let _logFilePath: string | null = null;
let _logDirEnsured = false;

function getLogFilePath(): string | null {
	if (_logFilePath) return _logFilePath;
	if (!_os || !_path) return null;
	_logFilePath = _path.join(_os.homedir(), ".pi", "logs", "retry-errors.log");
	return _logFilePath;
}

function ensureLogDir(filePath: string): void {
	if (_logDirEnsured || !_fs || !_path) return;
	const dir = _path.dirname(filePath);
	try {
		_fs.mkdirSync(dir, { recursive: true });
	} catch {
		// Directory may already exist or be uncreatable — either way, continue
	}
	_logDirEnsured = true;
}

/**
 * Log a retryable error to both the console (screen) and a persistent log file.
 *
 * @param tag   Short label, e.g. "agent-loop", "openai-completions"
 * @param message  Human-readable description of the retry event
 */
export function logRetryError(tag: string, message: string): void {
	const line = `[${tag}] ${message}`;

	// Always log to screen
	console.warn(line);

	// Append to log file (best-effort, non-blocking)
	const filePath = getLogFilePath();
	if (filePath && _fs) {
		ensureLogDir(filePath);
		const timestamp = new Date().toISOString();
		try {
			_fs.appendFileSync(filePath, `${timestamp} ${line}\n`);
		} catch {
			// Silently ignore write failures (permissions, disk full, etc.)
		}
	}
}
