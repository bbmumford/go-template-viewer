import * as vscode from 'vscode';
import * as os from 'os';

/**
 * Auto-dismissing notification helper (5 second timeout).
 * Uses progress notification for auto-dismiss with type-based prefix.
 */
export function showTimedNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
    const timeout = 5000;
    const prefix = type === 'error' ? '❌ ' : type === 'warning' ? '⚠️ ' : '';
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: false },
        async (progress) => {
            progress.report({ message: `${prefix}${message}` });
            await new Promise(resolve => setTimeout(resolve, timeout));
        }
    );
}

/**
 * Generate a sanitized file key from a relative path.
 * Replaces path separators with `--` to create a flat, unique filename.
 * e.g. "templates/admin/base.html" → "templates--admin--base.html"
 */
export function sanitizePathForFilename(relativePath: string): string {
    return relativePath.replace(/[\\/]/g, '--');
}

/**
 * Get the platform+arch specific helper binary name.
 * Maps Node.js process.platform/os.arch() to Go GOOS/GOARCH naming.
 * Falls back to plain "template-helper" if no platform-specific binary exists.
 */
export function getHelperBinaryName(): string {
    const platform = process.platform; // 'win32' | 'darwin' | 'linux'
    const arch = os.arch();            // 'x64' | 'arm64' | 'ia32'

    const goOS = platform === 'win32' ? 'windows' : platform;
    const goArch = arch === 'x64' ? 'amd64' : arch === 'ia32' ? '386' : arch; // arm64 stays arm64
    const ext = platform === 'win32' ? '.exe' : '';

    return `template-helper-${goOS}-${goArch}${ext}`;
}
