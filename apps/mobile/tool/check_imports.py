#!/usr/bin/env python3
"""Static checks for apps/mobile that run without the Flutter/Dart SDK.

Usage (from apps/mobile or anywhere):
    python3 tool/check_imports.py            # run all checks, exit 1 on errors
    python3 tool/check_imports.py --keys     # also print every l10n key used (JSON)

Checks
  1. Imports / exports / parts: every relative URI and every `package:jastipkita/...` URI
     resolves to an existing file (the gen-l10n output under lib/l10n/ is whitelisted because
     `flutter gen-l10n` creates it in CI). Every other `package:X/` must be declared in
     pubspec.yaml (lib/ may only use `dependencies`, test/ and tool/ may also use
     `dev_dependencies`). `dart:io` is refused in lib/ (the app also builds for web).
  2. Localisation: every key used through `context.l10n.key`, `l10n.key` (or any variable
     typed / assigned as AppLocalizations) and `AppLocalizations.of(context)!.key` exists in
     BOTH lib/l10n/app_id.arb (template) and lib/l10n/app_en.arb, with the same number of
     placeholders as arguments at the call site. The two ARB files must have the same keys and
     placeholders; every placeholder must be declared in the template metadata.
  3. Hygiene: no `TODO: implement`, no `print(` in lib/.

Plain Python 3.8+, no third-party modules.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = 'jastipkita'
ARB_TEMPLATE = ROOT / 'lib' / 'l10n' / 'app_id.arb'
ARB_OTHERS = [ROOT / 'lib' / 'l10n' / 'app_en.arb']
GENERATED = {
    'lib/l10n/app_localizations.dart',
    'lib/l10n/app_localizations_id.dart',
    'lib/l10n/app_localizations_en.dart',
}
SDK_PACKAGES = {'flutter', 'flutter_test', 'flutter_localizations', 'flutter_driver', 'integration_test'}
# Members of the generated class that are not message keys.
L10N_NON_KEYS = {'localeName', 'delegate', 'localizationsDelegates', 'supportedLocales', 'of', 'runtimeType', 'hashCode', 'toString'}
DART_RESERVED = {
    'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends',
    'false', 'final', 'finally', 'for', 'if', 'in', 'is', 'new', 'null', 'rethrow', 'return', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with',
}

errors: list[str] = []
warnings: list[str] = []


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def dart_files() -> list[Path]:
    out: list[Path] = []
    for folder in ('lib', 'test', 'tool', 'integration_test'):
        base = ROOT / folder
        if base.is_dir():
            out.extend(sorted(p for p in base.rglob('*.dart') if rel(p) not in GENERATED))
    return out


# ---------------------------------------------------------------------------------------------
# pubspec
# ---------------------------------------------------------------------------------------------

def pubspec_packages() -> tuple[set[str], set[str]]:
    deps: set[str] = set()
    dev: set[str] = set()
    current: set[str] | None = None
    for raw in (ROOT / 'pubspec.yaml').read_text(encoding='utf-8').splitlines():
        line = raw.split('#', 1)[0].rstrip()
        if not line.strip():
            continue
        if not line.startswith(' '):
            key = line.split(':', 1)[0].strip()
            current = deps if key == 'dependencies' else dev if key == 'dev_dependencies' else None
            continue
        if current is None:
            continue
        match = re.match(r'^  ([A-Za-z0-9_]+)\s*:', line)
        if match:
            current.add(match.group(1))
    return deps, dev


# ---------------------------------------------------------------------------------------------
# Source helpers
# ---------------------------------------------------------------------------------------------

DIRECTIVE = re.compile(
    r"^\s*(import|export|part)\s+(?!of\b)((?:'[^']*'|\"[^\"]*\")(?:\s*if\s*\([^)]*\)\s*(?:'[^']*'|\"[^\"]*\"))*)[^;]*;",
    re.MULTILINE,
)
URI_LITERAL = re.compile(r"'([^']*)'|\"([^\"]*)\"")


def strip_comments(source: str) -> str:
    """Removes // and /* */ comments while keeping string literals (and line numbers) intact."""
    out: list[str] = []
    i, n = 0, len(source)
    quote: str | None = None
    while i < n:
        c = source[i]
        if quote:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(source[i + 1])
                i += 2
                continue
            if source.startswith(quote, i):
                out.append(source[i + 1:i + len(quote)])
                i += len(quote)
                quote = None
                continue
            i += 1
            continue
        if source.startswith('//', i):
            j = source.find('\n', i)
            i = n if j == -1 else j
            continue
        if source.startswith('/*', i):
            j = source.find('*/', i + 2)
            chunk = source[i:(n if j == -1 else j + 2)]
            out.append('\n' * chunk.count('\n'))
            i = n if j == -1 else j + 2
            continue
        if c in ('"', "'"):
            quote = c * 3 if source.startswith(c * 3, i) else c
            # raw strings: r'...' behave the same for our purposes
            out.append(source[i:i + len(quote)])
            i += len(quote)
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def line_of(source: str, index: int) -> int:
    return source.count('\n', 0, index) + 1


# ---------------------------------------------------------------------------------------------
# 1. Imports
# ---------------------------------------------------------------------------------------------

def check_imports(files: list[Path]) -> None:
    deps, dev = pubspec_packages()
    for path in files:
        source = strip_comments(path.read_text(encoding='utf-8'))
        area = rel(path).split('/', 1)[0]
        allowed = deps | SDK_PACKAGES if area == 'lib' else deps | dev | SDK_PACKAGES
        for match in DIRECTIVE.finditer(source):
            line = line_of(source, match.start())
            for lit in URI_LITERAL.finditer(match.group(2)):
                uri = lit.group(1) if lit.group(1) is not None else lit.group(2)
                where = f'{rel(path)}:{line}'
                if uri.startswith('dart:'):
                    if uri == 'dart:io' and area == 'lib':
                        errors.append(f'{where}: dart:io is not available on web (flutter build web) — use a plugin instead')
                    continue
                if uri.startswith('package:'):
                    name, _, sub = uri[len('package:'):].partition('/')
                    if name == PACKAGE:
                        target = ROOT / 'lib' / sub
                        if rel(target) in GENERATED:
                            continue
                        if not target.is_file():
                            errors.append(f'{where}: {uri} -> lib/{sub} does not exist')
                    elif name not in allowed:
                        hint = ' (only in dev_dependencies)' if name in dev else ''
                        errors.append(f'{where}: package "{name}" is not declared in pubspec.yaml{hint}')
                    continue
                if re.match(r'^[a-z]+:', uri):
                    errors.append(f'{where}: unsupported URI {uri}')
                    continue
                target = (path.parent / uri).resolve()
                try:
                    target_rel = rel(target)
                except ValueError:
                    errors.append(f'{where}: {uri} points outside apps/mobile')
                    continue
                if target_rel in GENERATED:
                    continue
                if not target.is_file():
                    errors.append(f'{where}: {uri} -> {target_rel} does not exist')


# ---------------------------------------------------------------------------------------------
# 2. Localisation
# ---------------------------------------------------------------------------------------------

ALIAS_PATTERNS = [
    re.compile(r'\bAppLocalizations\??\s+([A-Za-z_]\w*)\b'),
    re.compile(r'\b(?:final|var|late\s+final)\s+([A-Za-z_]\w*)\s*=\s*[\w.]*\.l10n\s*;'),
    re.compile(r'\b(?:final|var|late\s+final)\s+([A-Za-z_]\w*)\s*=\s*AppLocalizations\.of\([^;]*\)!?\s*;'),
    re.compile(r'\b(?:final|var|late\s+final)\s+([A-Za-z_]\w*)\s*=\s*(?:lookupAppLocalizations\([^;]*\)|idStrings)\s*;'),
]
# Shared test helper (test/helpers.dart): `AppLocalizations get idStrings`.
GLOBAL_ALIASES = {'l10n', 'idStrings'}


def count_args(source: str, open_index: int) -> int | None:
    """Counts top-level arguments of the call whose '(' is at open_index."""
    depth = 0
    i = open_index
    n = len(source)
    args = 0
    has_token = False
    while i < n:
        c = source[i]
        if c in ('"', "'"):
            quote = c * 3 if source.startswith(c * 3, i) else c
            j = i + len(quote)
            while j < n and not source.startswith(quote, j):
                j += 2 if source[j] == '\\' else 1
            i = j + len(quote)
            has_token = True
            continue
        if c in '([{':
            depth += 1
            if depth > 1:
                has_token = True
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return args + (1 if has_token else 0)
        elif c == ',' and depth == 1:
            if has_token:
                args += 1
            has_token = False
        elif not c.isspace() and depth >= 1:
            has_token = True
        i += 1
    return None


def collect_l10n_usages(files: list[Path]) -> dict[str, list[tuple[str, int | None]]]:
    usages: dict[str, list[tuple[str, int | None]]] = {}
    for path in files:
        if rel(path).startswith('tool/'):
            continue
        source = strip_comments(path.read_text(encoding='utf-8'))
        # directives never contain message keys
        source = DIRECTIVE.sub(lambda m: '\n' * m.group(0).count('\n'), source)
        aliases = set(GLOBAL_ALIASES)
        for pattern in ALIAS_PATTERNS:
            aliases.update(pattern.findall(source))
        aliases.discard('AppLocalizations')
        alias_re = '|'.join(sorted(re.escape(a) for a in aliases))
        usage = re.compile(
            r'(?:(?<![\w.])(?:' + alias_re + r')|\.l10n|\bAppLocalizations\.of\([^()]*\)!?)\s*\.\s*([A-Za-z_]\w*)'
        )
        for match in usage.finditer(source):
            key = match.group(1)
            if key in L10N_NON_KEYS:
                continue
            k = match.end()
            while k < len(source) and source[k] in ' \t\n':
                k += 1
            arg_count = count_args(source, k) if k < len(source) and source[k] == '(' else 0
            usages.setdefault(key, []).append((f'{rel(path)}:{line_of(source, match.start())}', arg_count))
    return usages


PLACEHOLDER = re.compile(r'\{\s*([A-Za-z_]\w*)\s*(?:,|\})')


def message_placeholders(message: str, key: str, file_name: str) -> list[str]:
    """Top-level placeholders of an ICU message, in order of first appearance."""
    names: list[str] = []
    depth = 0
    i = 0
    while i < len(message):
        c = message[i]
        if c == '{':
            if depth == 0:
                match = PLACEHOLDER.match(message, i)
                if not match:
                    errors.append(f'{file_name}: "{key}" has a literal "{{" that is not a placeholder')
                elif match.group(1) not in names:
                    names.append(match.group(1))
            depth += 1
        elif c == '}':
            depth -= 1
            if depth < 0:
                errors.append(f'{file_name}: "{key}" has an unbalanced "}}"')
                return names
        i += 1
    if depth != 0:
        errors.append(f'{file_name}: "{key}" has unbalanced braces')
    if re.search(r'\{\s*\w+\s*,\s*(plural|select)\s*,', message) and 'other' not in message:
        errors.append(f'{file_name}: "{key}" plural/select needs an "other" case')
    return names


def load_arb(path: Path) -> dict:
    def no_duplicates(pairs):
        seen = {}
        for k, v in pairs:
            if k in seen:
                errors.append(f'{rel(path)}: duplicate key "{k}"')
            seen[k] = v
        return seen

    try:
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=no_duplicates)
    except FileNotFoundError:
        errors.append(f'{rel(path)}: missing')
    except json.JSONDecodeError as e:
        errors.append(f'{rel(path)}: invalid JSON ({e})')
    return {}


def check_l10n(files: list[Path], print_keys: bool) -> None:
    usages = collect_l10n_usages(files)
    if print_keys:
        print(json.dumps({k: sorted({a for _, a in v}, key=lambda x: -1 if x is None else x) for k, v in sorted(usages.items())}, indent=1))
    template = load_arb(ARB_TEMPLATE)
    if not template:
        return
    t_name = rel(ARB_TEMPLATE)
    t_keys = {k for k in template if not k.startswith('@')}
    t_placeholders: dict[str, list[str]] = {}
    for key in sorted(t_keys):
        if not re.match(r'^[a-z]\w*$', key) or key in DART_RESERVED:
            errors.append(f'{t_name}: "{key}" is not a valid lowerCamelCase Dart identifier')
        message = template[key]
        if not isinstance(message, str):
            errors.append(f'{t_name}: "{key}" must be a string')
            continue
        names = message_placeholders(message, key, t_name)
        meta = template.get('@' + key, {})
        declared = list((meta.get('placeholders') or {}).keys()) if isinstance(meta, dict) else []
        missing = [n for n in names if n not in declared]
        extra = [n for n in declared if n not in names]
        if missing:
            errors.append(f'{t_name}: "{key}" placeholders {missing} not declared in "@{key}"')
        if extra:
            errors.append(f'{t_name}: "@{key}" declares {extra} that the message does not use')
        for name, spec in ((meta.get('placeholders') or {}) if isinstance(meta, dict) else {}).items():
            if not isinstance(spec, dict) or 'type' not in spec:
                errors.append(f'{t_name}: "@{key}.placeholders.{name}" needs a "type"')
        t_placeholders[key] = declared or names
    for meta_key in (k for k in template if k.startswith('@') and not k.startswith('@@')):
        if meta_key[1:] not in t_keys:
            errors.append(f'{t_name}: metadata "{meta_key}" has no message')

    for other_path in ARB_OTHERS:
        other = load_arb(other_path)
        if not other:
            continue
        o_name = rel(other_path)
        o_keys = {k for k in other if not k.startswith('@')}
        for key in sorted(t_keys - o_keys):
            errors.append(f'{o_name}: missing "{key}"')
        for key in sorted(o_keys - t_keys):
            errors.append(f'{o_name}: "{key}" is not in the template {t_name}')
        for key in sorted(o_keys & t_keys):
            message = other[key]
            if not isinstance(message, str):
                errors.append(f'{o_name}: "{key}" must be a string')
                continue
            names = message_placeholders(message, key, o_name)
            unknown = [n for n in names if n not in t_placeholders.get(key, [])]
            if unknown:
                errors.append(f'{o_name}: "{key}" uses placeholders {unknown} that the template does not declare')
            dropped = [n for n in t_placeholders.get(key, []) if n not in names]
            if dropped:
                warnings.append(f'{o_name}: "{key}" does not use placeholders {dropped}')

    for key, sites in sorted(usages.items()):
        if key not in t_keys:
            errors.append(f'{sites[0][0]}: l10n key "{key}" is missing from the ARB files (used {len(sites)}x)')
            continue
        expected = len(t_placeholders.get(key, []))
        for where, count in sites:
            if count is None:
                warnings.append(f'{where}: could not count arguments for "{key}"')
            elif count != expected:
                errors.append(f'{where}: "{key}" called with {count} argument(s), ARB declares {expected}')
    for key in sorted(t_keys - usages.keys()):
        warnings.append(f'{t_name}: "{key}" is never used')


# ---------------------------------------------------------------------------------------------
# 3. Hygiene
# ---------------------------------------------------------------------------------------------

def check_hygiene(files: list[Path]) -> None:
    for path in files:
        raw = path.read_text(encoding='utf-8')
        for i, line in enumerate(raw.splitlines(), 1):
            if re.search(r'TODO:?\s*implement', line, re.IGNORECASE):
                errors.append(f'{rel(path)}:{i}: placeholder "TODO: implement"')
        if rel(path).startswith('lib/'):
            code = strip_comments(raw)
            for match in re.finditer(r'(?<![\w.])print\(', code):
                errors.append(f'{rel(path)}:{line_of(code, match.start())}: print() in app code (use debugPrint)')


def main(argv: list[str]) -> int:
    files = dart_files()
    check_imports(files)
    check_l10n(files, '--keys' in argv)
    check_hygiene(files)
    for w in warnings:
        print(f'warning: {w}')
    for e in errors:
        print(f'error: {e}')
    print(f'{len(files)} Dart files checked · {len(errors)} error(s) · {len(warnings)} warning(s)')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
