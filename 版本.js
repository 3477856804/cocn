#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ITER = 1000;
const PER_MINOR = 999;

class UsageError extends Error {}

function getVersion(iter, perMinor = PER_MINOR) {
    if (!Number.isInteger(iter) || iter < 1) {
        throw new RangeError(`iter must be integer >= 1, received: ${iter}`);
    }
    if (!Number.isInteger(perMinor) || perMinor < 1) {
        throw new RangeError(`perMinor must be integer >= 1, received: ${perMinor}`);
    }
    const zeroBased = iter - 1;
    const minor = Math.floor(zeroBased / perMinor);
    const patch = (zeroBased % perMinor) + 1;
    const core = `0.${minor}.${patch}`;
    return { core, full: `${core}+build.${iter}` };
}

function detectIndent(text) {
    const m = text.match(/^[ \t]+/m);
    return m ? m[0] : '  ';
}

function writeFileAtomic(filePath, content) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

function readPackage(pkgPath) {
    let raw;
    try {
        raw = fs.readFileSync(pkgPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`package.json not found: ${pkgPath}`);
        }
        throw err;
    }
    let pkg;
    try {
        pkg = JSON.parse(raw);
    } catch (err) {
        throw new Error(`parse package.json failed: ${err.message}`);
    }
    return { raw, pkg };
}

function serializePackage(raw, pkg) {
    const indent = detectIndent(raw);
    const trailingNewline = raw.endsWith('\n') ? '\n' : '';
    return JSON.stringify(pkg, null, indent) + trailingNewline;
}

function readBuildIter(pkg) {
    const val = Number(pkg._buildIter);
    return Number.isInteger(val) && val >= 1 ? val : null;
}

function parseIter(raw) {
    if (raw === undefined || raw === null || raw === '') {
        return DEFAULT_ITER;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new RangeError(`iter must be integer >= 1, received: ${JSON.stringify(raw)}`);
    }
    return n;
}

function parseArgv(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return { action: 'help' };
    }

    const flags = [];
    const positional = [];
    for (const a of argv) {
        if (a.startsWith('-')) flags.push(a);
        else positional.push(a);
    }

    for (const f of flags) {
        if (f !== '--auto') {
            throw new UsageError(`unknown option: ${f}`);
        }
    }
    if (flags.length > 1) {
        throw new UsageError('--auto specified more than once');
    }
    if (flags.length === 1 && positional.length > 0) {
        throw new UsageError('--auto cannot be combined with an explicit iter');
    }
    if (positional.length > 1) {
        throw new UsageError(`unexpected arguments: ${positional.slice(1).join(' ')}`);
    }
    if (flags.length === 1) {
        return { action: 'auto' };
    }
    return { action: 'set', iter: positional[0] };
}

function bump(pkgPath, action, iterArg) {
    const { raw, pkg } = readPackage(pkgPath);
    const iter = action === 'auto'
        ? (readBuildIter(pkg) ?? 0) + 1
        : parseIter(iterArg ?? process.env.GLOBAL_ITER);
    const { core, full } = getVersion(iter);
    const previous = pkg.version;
    const versionChanged = pkg.version !== core;
    const iterChanged = pkg._buildIter !== iter;
    if (!versionChanged && !iterChanged) {
        return { iter, core, full, previous, changed: false };
    }
    pkg.version = core;
    pkg._buildIter = iter;
    writeFileAtomic(pkgPath, serializePackage(raw, pkg));
    return { iter, core, full, previous, changed: true };
}

function printHelp() {
    console.log([
        'Usage: bump-version [iter|--auto|--help]',
        '',
        '  iter        set explicit global iteration number (>=1)',
        '  --auto      auto increment from stored _buildIter inside package.json',
        '  --help, -h  show this help message',
        '',
        'Environment:',
        '  GLOBAL_ITER  fallback iteration number',
    ].join('\n'));
}

function run(argv = process.argv.slice(2)) {
    let plan;
    try {
        plan = parseArgv(argv);
    } catch (err) {
        console.error(err.message);
        printHelp();
        return 1;
    }

    if (plan.action === 'help') {
        printHelp();
        return 0;
    }

    const pkgPath = path.join(__dirname, 'package.json');
    let result;
    try {
        result = bump(pkgPath, plan.action, plan.iter);
    } catch (err) {
        console.error(`update failed: ${err.message}`);
        return 1;
    }

    console.log(`global iter: ${result.iter}`);
    console.log(`previous version: ${result.previous}`);
    console.log(`package.json version: ${result.core}${result.changed ? '' : ' (no change)'}`);
    console.log(`full git tag version: ${result.full}`);
    return 0;
}

function main(argv = process.argv.slice(2)) {
    return run(argv);
}

if (require.main === module) {
    process.exit(main());
}

module.exports = {
    getVersion,
    bump,
    parseIter,
    parseArgv,
    readBuildIter,
    readPackage,
    run,
    main,
    UsageError,
    PER_MINOR,
    DEFAULT_ITER
};