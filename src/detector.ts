/**
 * Deciding whether a compaction failure was a content-policy refusal.
 *
 * Deliberately positive-matching only: we look for policy vocabulary in the error
 * message and never key off a status code. `400` is also what context-length and
 * malformed-request errors return, so matching on it would fire on the wrong failures.
 */

/** The subset of pi's `SessionCompactFailedEvent` this module needs. */
export interface CompactFailureLike {
	errorMessage?: string;
	aborted: boolean;
}

export function isPolicyRefusal(event: CompactFailureLike, patterns: readonly RegExp[]): boolean {
	// A cancellation carries no message and is not a refusal: the user asked to stop.
	if (event.aborted) return false;

	const message = event.errorMessage;
	// Defensive: a non-abort failure always carries a message in pi, but never guess.
	if (!message) return false;

	return patterns.some((pattern) => pattern.test(message));
}

export interface CompiledPatterns {
	compiled: RegExp[];
	invalid: string[];
}

export function compilePatterns(sources: readonly string[], caseInsensitive: boolean): CompiledPatterns {
	const compiled: RegExp[] = [];
	const invalid: string[] = [];

	for (const source of sources) {
		try {
			compiled.push(new RegExp(source, caseInsensitive ? "i" : ""));
		} catch {
			invalid.push(source);
		}
	}

	return { compiled, invalid };
}
