# Architecture rules — latam-validator-api

These rules are mandatory for all code that lands on `main`. A PR that breaks them must be fixed before merging.

## Validator contract

Every public validator is named `validate_<document>_<country>(value: str) -> dict` and always returns the same contract:

```python
{"valid": bool, "reason": str | None}
```

- When the document is valid, `reason` is `None`.
- Extra informational keys are allowed (for example `check_digit` or `type`), but errors are reported **only** in `reason`. Using other keys for errors, such as `error` or `message`, is forbidden.
- Validators never raise exceptions for invalid input: they return `{"valid": False, "reason": ...}`.

## Validator registry by country

- The validator for a country is chosen through a **registry** (a dictionary that maps ISO-3166 alpha-2 codes to functions). Adding a country means adding an entry to the registry, without changing the dispatch logic.
- `if/elif` chains by country are forbidden.
- Country codes are normalized (lowercase, no spaces) **before** any lookup or comparison.

## State and caching

- Mutable module-level global state (dictionaries, lists or counters modified at runtime) is forbidden. The API runs with several workers and threads.
- If caching is needed, use `functools.lru_cache` with an explicit `maxsize` on pure functions. Never an unbounded global dictionary.
- Cache keys are built from already-normalized values.

## Code duplication

- Each function is defined only once in a module. Defining the same function twice is forbidden, because Python silently replaces the first definition.
- Input cleanup (removing spaces, dashes and dots) is centralized in a single `_normalize(value, strip=...)` helper. It is not copied into each validator.

## Observability

- `print` is forbidden in library code. Use `logging.getLogger(__name__)`.
- Full identity document numbers are never written to logs (they are personal data): mask every digit except the last 4.

## Imports and structure

- All imports go at the top of the module. Imports inside functions are forbidden.
- Tests live in `tests/` and use `pytest`. The `if __name__ == "__main__":` block is not used for tests.
