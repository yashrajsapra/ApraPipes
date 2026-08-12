/**
 * kb-gen runner -- executed by WorkflowEngine with context primitives.
 *
 * Phases:
 *   1. setup   -- kb_setup + initial repo mapping + directory discovery
 *   2. scan    -- parallel agents, each scanning a chunk of files
 *   3. connect -- cross-cutting pattern discovery
 *   4. promote -- verify and promote INFERRED entries to CONFIRMED
 *   5. export  -- kb_export + kb_stats report
 */

export async function main(context) {
    const { agent, log, phase, args, parallel } = context;
    const { memberName, depth, autoPromote } = args;

    // ---------------------------------------------------------------
    // Phase 1: Setup + map the repo + discover file groups
    // ---------------------------------------------------------------
    await phase('setup');
    log('Phase 1: Setting up KB and mapping repo structure...');

    const mapResult = await agent(
        [
            'You are a codebase analyst. Your job is to set up the Knowledge Bank and map this repo.',
            '',
            'Steps:',
            '1. Run kb_setup for this repo (use the repo root as repo_path).',
            '2. Run kb_session_prime to load any existing KB entries.',
            '3. Use the Bash tool to list the top-level directory structure:',
            '   - ls -la to see all files/dirs',
            '   - Find key files: package.json, Cargo.toml, go.mod, requirements.txt, CMakeLists.txt, etc.',
            '   - Identify the main source directories (src/, lib/, packages/, base/, etc.)',
            '4. Use code_map if available to get a structural overview.',
            '5. CRITICAL: Run this command and return its COMPLETE output as the LAST thing in your response:',
            '   find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" \\',
            '     -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \\',
            '     -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.hpp" \\',
            '     -o -name "*.cc" -o -name "*.hh" -o -name "*.cxx" \\) \\',
            '     -not -path "*/node_modules/*" -not -path "*/.git/*" \\',
            '     -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/vendor/*" \\',
            '     -not -path "*/thirdparty/*" -not -path "*/__pycache__/*" \\',
            '     | sort',
            '',
            'Your response MUST end with the full file listing from the find command.',
            'Return a summary of what language/framework this project uses,',
            'the main directories and their purposes, key entry points and config files.',
            'Keep your summary under 500 words. Focus on structure, not content.',
        ].join('\n'),
        {
            member_name: memberName,
            label: 'Repo Structure Mapping',
            model: 'cheap',
        }
    );
    log('Phase 1 complete: repo structure mapped.');

    // ---------------------------------------------------------------
    // Phase 2: Scan -- parallel agents by directory chunk
    // ---------------------------------------------------------------
    await phase('scan');

    if (depth === 'shallow') {
        log('Phase 2: Shallow scan -- single agent on key files...');
        await agent(buildShallowScanPrompt(), {
            member_name: memberName,
            label: 'Shallow Scan',
            model: 'standard',
            timeout_s: 600,
            max_turns: 100,
        });
        log('Phase 2 complete: shallow scan done.');
    } else {
        log('Phase 2: Deep scan -- splitting into parallel agents by directory...');

        const chunks = buildDirectoryChunks(mapResult);
        log(`Phase 2: Found ${chunks.length} directory chunks to scan in parallel.`);

        const scanTasks = chunks.map((chunk, i) => () =>
            agent(buildChunkScanPrompt(chunk, i, chunks.length), {
                member_name: memberName,
                label: `Scan chunk ${i + 1}/${chunks.length}: ${chunk.label}`,
                model: 'standard',
                timeout_s: 900,
                max_turns: 150,
            })
        );

        await parallel(scanTasks);
        log('Phase 2 complete: all chunks scanned.');
    }

    // ---------------------------------------------------------------
    // Phase 3: Cross-learning -- chain per-file learnings into
    // module relationships, data flows, and architectural patterns
    // ---------------------------------------------------------------
    await phase('connect');
    log('Phase 3: Cross-learning -- chaining per-file learnings...');

    // Step 3a: Build a knowledge map from everything Phase 2 captured
    const knowledgeMap = await agent(
        [
            'You are a codebase analyst. Phase 2 just scanned individual files into the KB.',
            'Your job: build a KNOWLEDGE MAP that summarizes what was learned.',
            '',
            'Steps:',
            '1. Run kb_list to get ALL entries captured so far.',
            '2. Group entries by directory/module.',
            '3. For each module, note:',
            '   - What symbols/classes it exports',
            '   - What other modules it imports or depends on',
            '   - What responsibility it owns',
            '4. Build a dependency map: which modules call/import which other modules?',
            '   Look at #include, import, require patterns in the entry content.',
            '',
            'Return your findings as a structured summary:',
            '- List each module with its key exports and dependencies',
            '- Note any modules that appear to be "hub" modules (many dependents)',
            '- Note any modules that seem isolated (no inbound references)',
            '',
            'Do NOT call kb_capture yet -- just analyze and return your summary.',
            'Keep it under 1000 words. Focus on relationships, not individual file details.',
        ].join('\n'),
        {
            member_name: memberName,
            label: 'Build Knowledge Map',
            model: 'standard',
        }
    );
    log('Phase 3a: Knowledge map built. Launching cross-cutting analyzers...');

    // Step 3b: Parallel agents, each chasing a specific cross-cutting dimension
    const dimensions = [
        {
            label: 'Data Flow & Pipeline',
            prompt: [
                'You are analyzing DATA FLOW patterns across this codebase.',
                '',
                'Context from the knowledge map:',
                typeof knowledgeMap === 'string' ? knowledgeMap : JSON.stringify(knowledgeMap),
                '',
                'Steps:',
                '1. Run kb_query for terms like "pipeline", "frame", "data", "buffer",',
                '   "queue", "stream", "input", "output", "process", "transform".',
                '2. Read 3-5 key files that are data pipeline hubs (connectors, routers,',
                '   entry points) based on the knowledge map above.',
                '3. Trace the data flow: Where does data enter? How is it transformed?',
                '   Where does it exit? What are the intermediate stages?',
                '4. For EACH data flow pattern you find, call kb_capture with:',
                '   - type: "knowledge"',
                '   - title: "Data Flow: <pattern name>"',
                '   - content: which modules participate, in what order, what transforms happen',
                '   - source_files: the files involved',
                '',
                'Focus on how data moves BETWEEN modules, not within a single file.',
            ].join('\n'),
        },
        {
            label: 'Error Handling & Resilience',
            prompt: [
                'You are analyzing ERROR HANDLING patterns across this codebase.',
                '',
                'Context from the knowledge map:',
                typeof knowledgeMap === 'string' ? knowledgeMap : JSON.stringify(knowledgeMap),
                '',
                'Steps:',
                '1. Run kb_query for terms like "error", "exception", "throw", "catch",',
                '   "fail", "retry", "log", "abort", "status".',
                '2. Read 3-5 files to see how errors are handled -- is there a central',
                '   error handler? Do modules propagate errors up? Exception types?',
                '3. For EACH error handling pattern, call kb_capture with:',
                '   - type: "knowledge"',
                '   - title: "Error Handling: <pattern name>"',
                '   - content: the strategy, which modules use it, how errors propagate',
                '   - source_files: files that implement or exemplify the pattern',
                '',
                'Also look for: logging strategy, assertion patterns, graceful degradation.',
            ].join('\n'),
        },
        {
            label: 'Config & Initialization',
            prompt: [
                'You are analyzing CONFIGURATION and INITIALIZATION patterns.',
                '',
                'Context from the knowledge map:',
                typeof knowledgeMap === 'string' ? knowledgeMap : JSON.stringify(knowledgeMap),
                '',
                'Steps:',
                '1. Run kb_query for terms like "config", "init", "setup", "props",',
                '   "env", "options", "settings", "parameters", "cmake", "build".',
                '2. Read the build system files (CMakeLists.txt, package.json, etc.).',
                '3. Trace: How is the system configured? What gets initialized first?',
                '   How do config values flow from the top level into modules?',
                '4. For EACH pattern, call kb_capture with:',
                '   - type: "knowledge"',
                '   - title: "Config: <pattern name>"',
                '   - content: what is configured, how values propagate, defaults',
                '   - source_files: files involved',
                '',
                'Also capture any build/deploy procedures as type "runbook".',
            ].join('\n'),
        },
        {
            label: 'Testing & Quality Patterns',
            prompt: [
                'You are analyzing TESTING patterns and conventions.',
                '',
                'Context from the knowledge map:',
                typeof knowledgeMap === 'string' ? knowledgeMap : JSON.stringify(knowledgeMap),
                '',
                'Steps:',
                '1. Run kb_query for terms like "test", "boost", "assert", "fixture",',
                '   "mock", "expect", "verify", "benchmark".',
                '2. Read 3-5 test files to understand:',
                '   - What framework is used (Boost.Test, gtest, pytest, jest, etc.)?',
                '   - What naming conventions do tests follow?',
                '   - How are test fixtures set up?',
                '   - What is the test-to-source file mapping convention?',
                '3. For EACH testing pattern, call kb_capture with:',
                '   - type: "knowledge"',
                '   - title: "Testing: <pattern name>"',
                '   - content: framework, conventions, setup patterns',
                '   - source_files: example test files',
                '',
                'Also capture: CI pipeline patterns, linting, code quality tooling.',
            ].join('\n'),
        },
    ];

    const connectTasks = dimensions.map(dim => () =>
        agent(dim.prompt, {
            member_name: memberName,
            label: `Cross-learn: ${dim.label}`,
            model: 'standard',
            timeout_s: 600,
            max_turns: 100,
        })
    );

    await parallel(connectTasks);
    log('Phase 3b: Cross-cutting dimensions analyzed.');

    // Step 3c: Synthesize -- one agent reads everything and captures architecture
    await agent(
        [
            'You are the final synthesis agent. All individual files AND cross-cutting',
            'patterns have been captured into the KB.',
            '',
            'Your job: produce the ARCHITECTURAL OVERVIEW -- the "30,000-foot view".',
            '',
            'Steps:',
            '1. Run kb_query for "Data Flow", "Error Handling", "Config", "Testing"',
            '   to read the cross-cutting patterns that were just captured.',
            '2. Run kb_list to see all entries.',
            '3. Synthesize into high-level knowledge entries:',
            '',
            '   a. Call kb_capture with type "knowledge", title "Architecture Overview":',
            '      - What this system IS (one paragraph)',
            '      - The major subsystems/layers and how they connect',
            '      - The key design decisions (why is it built this way?)',
            '',
            '   b. Call kb_capture with type "knowledge", title "Module Dependency Map":',
            '      - Which modules depend on which',
            '      - What the dependency direction is (does data flow left-to-right?',
            '        top-to-bottom? hub-and-spoke?)',
            '',
            '   c. Call kb_capture with type "knowledge", title "Developer Guide":',
            '      - How a new developer would navigate this codebase',
            '      - Where to start reading',
            '      - Common pitfalls or non-obvious conventions',
            '',
            '   d. If you notice any CONTRADICTIONS between entries (e.g. one entry says',
            '      "errors are logged" but another shows they are thrown), call kb_capture',
            '      with type "knowledge" to document the inconsistency.',
            '',
            'Each kb_capture call should reference the source entries/files it draws from.',
        ].join('\n'),
        {
            member_name: memberName,
            label: 'Architecture Synthesis',
            model: 'standard',
        }
    );
    log('Phase 3c: Architecture synthesized.');
    log('Phase 3 complete: cross-learning chain finished.');

    // ---------------------------------------------------------------
    // Phase 4: Auto-promote INFERRED entries to CONFIRMED
    // ---------------------------------------------------------------
    if (autoPromote !== false) {
        await phase('promote');
        log('Phase 4: Verifying and promoting INFERRED entries to CONFIRMED...');

        await agent(
            [
                'You are a KB quality reviewer. Your job is to verify INFERRED entries and promote valid ones to CONFIRMED.',
                '',
                'Steps:',
                '1. Run kb_list with confidence="INFERRED" to get all INFERRED entries.',
                '2. For EACH entry, verify it is accurate:',
                '   - For context-cache entries: check that the source_files exist',
                '     (use Bash: test -f <path>). If the file exists, the entry is valid.',
                '   - For knowledge entries: briefly check that the described pattern',
                '     is real by spot-checking one of the source_files mentioned.',
                '3. For each VALID entry, call kb_promote with:',
                '   - id: the entry id',
                '   - reason: "Verified: source files exist and summary is accurate"',
                '     (reason must be at least 20 characters)',
                '4. For entries that reference files that no longer exist, call',
                '   kb_feedback to flag them instead of promoting.',
                '',
                'IMPORTANT:',
                '- Do NOT skip the verification step -- actually check files exist',
                '- Promote entries in batches, do not wait until the end',
                '- context-cache entries where the file exists are safe to promote',
                '- knowledge entries need a quick spot-check of at least one source file',
                '- Skip entries titled "test entry" or similar junk -- flag them with kb_feedback',
            ].join('\n'),
            {
                member_name: memberName,
                label: 'Auto-promote INFERRED to CONFIRMED',
                model: 'cheap',
                timeout_s: 1800,
                max_turns: 200,
            }
        );
        log('Phase 4 complete: entries promoted.');
    } else {
        log('Phase 4: Auto-promote skipped (--no-promote).');
    }

    // ---------------------------------------------------------------
    // Phase 5: Export + stats
    // ---------------------------------------------------------------
    await phase('export');
    log('Phase 5: Exporting KB and reporting stats...');

    await agent(
        [
            'Final step: export the Knowledge Bank and report coverage.',
            '',
            '1. Run kb_export to write the canonical bible (.fleet/kb-canonical.json).',
            '2. Run kb_stats to get coverage metrics.',
            '3. Run kb_list to see all entries that were captured.',
            '4. Summarize:',
            '   - Total entries captured (by type: context-cache, knowledge, runbook)',
            '   - Confidence levels (UNVERIFIED vs INFERRED vs CONFIRMED)',
            '   - Any gaps or areas that need manual promotion',
            '',
            'Report the final stats clearly.',
        ].join('\n'),
        {
            member_name: memberName,
            label: 'KB Export + Stats Report',
            model: 'cheap',
        }
    );
    log('Phase 5 complete: KB exported.');
    log('KB generation workflow finished successfully.');
}

/**
 * Parse the setup agent's output to extract file paths,
 * then group them into chunks of ~40 files by directory.
 */
function buildDirectoryChunks(setupOutput) {
    const text = typeof setupOutput === 'string' ? setupOutput : JSON.stringify(setupOutput);

    // Extract file paths from the agent's output
    const filePattern = /\.\/[^\s]+\.(ts|js|mjs|py|go|rs|java|c|cpp|h|hpp|cc|hh|cxx)/g;
    const allFiles = [...new Set((text.match(filePattern) || []))];

    if (allFiles.length === 0) {
        // Fallback: return a single chunk that tells the agent to discover files itself
        return [{
            label: 'all-sources',
            files: [],
            directories: [],
            fallback: true,
        }];
    }

    // Group by top-level directory (first 2 path segments)
    const groups = {};
    for (const f of allFiles) {
        const parts = f.replace('./', '').split('/');
        const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
    }

    // Merge small groups, split large ones into chunks of ~40
    const MAX_CHUNK = 40;
    const chunks = [];
    let overflow = { label: 'misc', files: [] };

    for (const [dir, files] of Object.entries(groups)) {
        if (files.length <= 5) {
            overflow.files.push(...files);
            continue;
        }
        if (files.length <= MAX_CHUNK) {
            chunks.push({ label: dir, files, directories: [dir], fallback: false });
        } else {
            // Split into sub-chunks
            for (let i = 0; i < files.length; i += MAX_CHUNK) {
                const slice = files.slice(i, i + MAX_CHUNK);
                const partNum = Math.floor(i / MAX_CHUNK) + 1;
                chunks.push({
                    label: `${dir} (part ${partNum})`,
                    files: slice,
                    directories: [dir],
                    fallback: false,
                });
            }
        }
    }

    if (overflow.files.length > 0) {
        chunks.push(overflow);
    }

    // If parsing produced nothing useful, fallback
    if (chunks.length === 0) {
        return [{
            label: 'all-sources',
            files: [],
            directories: [],
            fallback: true,
        }];
    }

    return chunks;
}

function buildChunkScanPrompt(chunk, index, total) {
    if (chunk.fallback) {
        return buildDeepScanPrompt();
    }

    const fileList = chunk.files.map(f => `  ${f}`).join('\n');

    return [
        `You are a codebase analyst performing a DEEP scan.`,
        `You are agent ${index + 1} of ${total}, responsible for scanning: ${chunk.label}`,
        '',
        `Your assigned files (${chunk.files.length} files):`,
        fileList,
        '',
        'For EACH file in your list:',
        '  1. Read the file using the Read tool or Bash (cat)',
        '  2. Call kb_capture with:',
        '     - type: "context-cache"',
        '     - title: the file path (e.g. "base/src/Module.cpp")',
        '     - summary: 2-3 sentence description of what this file does',
        '     - content: key classes, functions, their purposes, important patterns',
        '     - symbols: exported/public symbols (function names, class names)',
        '     - source_files: [the file path]',
        '',
        'After scanning all files in your chunk, if you notice a module-level pattern,',
        'call kb_capture with type "knowledge" to describe how these files relate.',
        '',
        'IMPORTANT:',
        '- Call kb_capture AFTER each file -- do NOT batch them all at the end',
        '- You MUST scan ALL files in your list, do not stop early',
        '- Focus on WHAT and WHY, not line-by-line code',
        '- Skip generated files, lockfiles, and trivial config',
        '- For test files, capture WHAT is being tested and the testing pattern',
        '- For header files, capture the public API and key types/structs',
    ].join('\n');
}

function buildShallowScanPrompt() {
    return [
        'You are a codebase analyst performing a SHALLOW scan.',
        'Focus on the most important files only.',
        '',
        'Steps:',
        '1. Identify the 10-15 most important files in this repo:',
        '   - Main entry points',
        '   - Core modules / key classes',
        '   - Configuration files',
        '   - API definitions / route handlers',
        '',
        '2. For EACH important file:',
        '   a. Read the file',
        '   b. Call kb_capture with:',
        '      - type: "context-cache"',
        '      - title: the file path',
        '      - summary: 2-3 sentence description of what this file does',
        '      - content: key exports, classes, functions, and their purposes',
        '      - symbols: main exported symbols',
        '      - source_files: [the file path]',
        '',
        '3. For any architectural patterns you notice, call kb_capture with:',
        '   - type: "knowledge"',
        '   - Describe the pattern and which files implement it',
        '',
        'Work through files systematically. Call kb_capture after analyzing each file.',
    ].join('\n');
}

function buildDeepScanPrompt() {
    return [
        'You are a codebase analyst performing a DEEP scan.',
        'Your goal: capture every meaningful file and pattern into the Knowledge Bank.',
        '',
        'Steps:',
        '1. List ALL source files (exclude node_modules, .git, dist, build, vendor).',
        '   Use: find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" ',
        '        -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" ',
        '        -o -name "*.c" -o -name "*.cpp" -o -name "*.h" \\) ',
        '        -not -path "*/node_modules/*" -not -path "*/.git/*" ',
        '        -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/vendor/*"',
        '',
        '2. Group files by directory/module.',
        '',
        '3. For EACH source file:',
        '   a. Read the file',
        '   b. Call kb_capture with:',
        '      - type: "context-cache"',
        '      - title: the file path',
        '      - summary: what this file does (2-3 sentences)',
        '      - content: key exports, classes, functions, their purposes,',
        '        important constants, and notable patterns',
        '      - symbols: exported symbols (function names, class names, constants)',
        '      - source_files: [the file path]',
        '',
        '4. After scanning each directory/module, call kb_capture with:',
        '   - type: "knowledge"',
        '   - title: "Module: <directory name>"',
        '   - Describe the module\'s responsibility and how it connects to others',
        '',
        '5. For step-by-step procedures you discover (build, deploy, test setup),',
        '   call kb_capture with type "runbook".',
        '',
        'IMPORTANT:',
        '- Call kb_capture as you go, do NOT batch them all at the end',
        '- Include symbol names so kb_query can find entries by function/class name',
        '- Focus on WHAT and WHY, not line-by-line code description',
        '- Skip generated files, lockfiles, and trivial config',
    ].join('\n');
}
