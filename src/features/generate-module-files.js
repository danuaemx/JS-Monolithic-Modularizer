import { findDependencies, generateImportStatements, toKebabCase } from '../utils.js';

function mergeDependencies(targetDependencies, sourceDependencies, currentPath) {
    for (const [dependencyPath, names] of sourceDependencies.entries()) {
        if (dependencyPath === currentPath) continue;
        if (!targetDependencies.has(dependencyPath)) targetDependencies.set(dependencyPath, new Set());
        names.forEach(name => targetDependencies.get(dependencyPath).add(name));
    }
}

function buildRuntimeChunks({ stateDeclarations, domElementDeclarations, nonMovableFunctionNames, functionSources, otherTopLevelCode }) {
    const chunks = [];
    const seen = new Set();

    const pushChunk = (source) => {
        const normalized = (source || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        chunks.push(normalized);
    };

    if (stateDeclarations) stateDeclarations.forEach(pushChunk);
    if (domElementDeclarations) domElementDeclarations.forEach(pushChunk);
    if (nonMovableFunctionNames && functionSources) {
        nonMovableFunctionNames.forEach(name => pushChunk(functionSources[name]));
    }
    if (otherTopLevelCode) otherTopLevelCode.forEach(pushChunk);

    return chunks;
}

function sanitizePathSegment(rawValue, fallback) {
    const normalized = String(rawValue ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');

    return normalized || fallback;
}

function normalizeRootDirectory(rawValue) {
    const value = String(rawValue ?? '').trim();
    if (!value) return 'src';

    const segments = value
        .split('/')
        .map(segment => sanitizePathSegment(segment, ''))
        .filter(Boolean);

    return segments.length > 0 ? segments.join('/') : 'src';
}

function normalizeNameStyle(rawStyle) {
    const style = String(rawStyle ?? '').toLowerCase();
    return ['kebab', 'snake', 'camel'].includes(style) ? style : 'kebab';
}

function formatModuleName(entityName, style) {
    const baseName = toKebabCase(String(entityName ?? '').replace(/[^a-zA-Z0-9_$]/g, '')).trim();
    const safeBaseName = baseName || 'module';

    if (style === 'snake') return safeBaseName.replace(/-/g, '_');
    if (style === 'camel') {
        return safeBaseName.replace(/-([a-z0-9])/g, (_, group) => group.toUpperCase());
    }

    return safeBaseName;
}

export function generateModuleFiles(clusters, analysis, options = {}) {
    const { functionSources, classSources, topLevelCalls, otherTopLevelCode, nonMovableFunctionNames, functionNodes, classNodes, domElementDeclarations, stateDeclarations } = analysis;

    const configuration = {
        outputRootDir: normalizeRootDirectory(options.outputRootDir),
        featuresDirName: sanitizePathSegment(options.featuresDirName, 'features'),
        coreDirName: sanitizePathSegment(options.coreDirName, 'core'),
        utilsFileName: sanitizePathSegment(options.utilsFileName, 'utils'),
        fileNameStyle: normalizeNameStyle(options.fileNameStyle),
        hierarchyThreshold: Math.max(0, Number.parseInt(options.hierarchyThreshold, 10) || 0),
    };

    const featureDirPath = `${configuration.outputRootDir}/${configuration.featuresDirName}`;
    const coreDirPath = `${configuration.outputRootDir}/${configuration.coreDirName}`;
    const runtimePath = `${coreDirPath}/runtime.js`;
    const indexPath = `${configuration.outputRootDir}/index.js`;
    const utilsPath = `${configuration.outputRootDir}/${configuration.utilsFileName}.js`;
    const featurePrefix = `${featureDirPath}/`;

    const files = {};
    const entityToModuleMap = new Map();

    // --- 1. INITIAL GRANULAR MAPPING (ONE FILE PER ENTITY) ---
    const classNames = Object.keys(classSources).sort((a, b) => a.localeCompare(b));
    classNames.forEach(name => {
        entityToModuleMap.set(name, { path: `${coreDirPath}/${formatModuleName(name, configuration.fileNameStyle)}.js` });
    });

    Object.entries(clusters)
        .sort(([clusterA], [clusterB]) => clusterA.localeCompare(clusterB))
        .forEach(([clusterName, functions]) => {
        if (functions.length === 0) return;
        const sortedFunctions = [...functions].sort((a, b) => a.localeCompare(b));

        if (clusterName === 'utils') {
            const path = utilsPath;
            sortedFunctions.forEach(f => entityToModuleMap.set(f, { path }));
        } else {
            sortedFunctions.forEach(f => {
                const path = `${featureDirPath}/${formatModuleName(f, configuration.fileNameStyle)}.js`;
                entityToModuleMap.set(f, { path });
            });
        }
    });

    // --- 2. HIERARCHICAL RESTRUCTURING ---
    const allDeclarations = [...Object.keys(functionSources), ...classNames];
    const moduleDependencies = new Map();
    const allModulePaths = [...new Set(Array.from(entityToModuleMap.values()).map(v => v.path))]
        .sort((a, b) => a.localeCompare(b));

    allModulePaths.forEach(path => {
        const entitiesInModule = [...entityToModuleMap.entries()]
            .filter(([, info]) => info.path === path)
            .map(([name]) => name)
            .sort((a, b) => a.localeCompare(b));
        const nodesInModule = entitiesInModule.map(name => functionNodes.get(name) || classNodes.get(name)).filter(Boolean);
        const dependencies = new Map();

        nodesInModule.forEach(node => {
            const entityDeps = findDependencies(node, entityToModuleMap, allDeclarations);
            mergeDependencies(dependencies, entityDeps, path);
        });

        moduleDependencies.set(path, dependencies);
    });

    const finalEntityToModuleMap = new Map(entityToModuleMap);
    const featureModulePaths = allModulePaths
        .filter(path => path.startsWith(featurePrefix))
        .sort((a, b) => a.localeCompare(b));
    const alreadyRelocatedDependencyPaths = new Set();

    if (configuration.hierarchyThreshold > 0) {
        const aggregatorCandidates = featureModulePaths
            .map(path => {
                const directDeps = moduleDependencies.get(path) || new Map();
                const dependencies = [...directDeps.keys()]
                    .filter(depPath => depPath.startsWith(featurePrefix) && depPath !== path)
                    .sort((a, b) => a.localeCompare(b));
                return { path, dependencies };
            })
            .filter(candidate => candidate.dependencies.length >= configuration.hierarchyThreshold)
            .sort((candidateA, candidateB) => {
                const byDependencyCount = candidateB.dependencies.length - candidateA.dependencies.length;
                return byDependencyCount !== 0 ? byDependencyCount : candidateA.path.localeCompare(candidateB.path);
            });

        aggregatorCandidates.forEach(({ path: aggregatorPath, dependencies }) => {
            const aggregatorName = aggregatorPath.replace(featurePrefix, '').replace('.js', '');
            const newBaseDir = `${featureDirPath}/${aggregatorName}`;

            dependencies.forEach(depPath => {
                if (alreadyRelocatedDependencyPaths.has(depPath)) return;

                const depName = depPath.replace(featurePrefix, '').replace('.js', '');
                const newPath = `${newBaseDir}/${depName}.js`;

                const entitiesToMove = [...finalEntityToModuleMap.entries()]
                    .filter(([, info]) => info.path === depPath)
                    .map(([name]) => name);

                if (entitiesToMove.length === 0) return;

                entitiesToMove.forEach(entityName => {
                    finalEntityToModuleMap.set(entityName, { path: newPath });
                });

                alreadyRelocatedDependencyPaths.add(depPath);
            });
        });
    }

    // --- 3. BUILD COMPLETE MAP & CALCULATE EXPORTS ---
    const fullEntityMap = new Map(finalEntityToModuleMap);

    // Group all non-movable code into the runtime module
    const runtimeEntities = new Set([...nonMovableFunctionNames, ...domElementDeclarations.keys(), ...stateDeclarations.keys()]);
    runtimeEntities.forEach(name => {
        fullEntityMap.set(name, { path: runtimePath });
    });

    const allKnownEntities = [...Object.keys(functionSources), ...classNames, ...domElementDeclarations.keys(), ...stateDeclarations.keys()];

    const allNeededExports = new Set(topLevelCalls.filter(Boolean));
    for (const name of [...fullEntityMap.keys()]) {
        const node = functionNodes.get(name) || classNodes.get(name);
        if (!node && !runtimeEntities.has(name)) continue;

        const currentModulePath = fullEntityMap.get(name)?.path;

        const dependencies = node
            ? findDependencies(node, fullEntityMap, allKnownEntities)
            : new Map();

        for (const [depPath, names] of dependencies.entries()) {
            if (depPath !== currentModulePath) {
                names.forEach(n => allNeededExports.add(n));
            }
        }
    }

    const runtimeDependencySource = buildRuntimeChunks({
        stateDeclarations,
        domElementDeclarations,
        nonMovableFunctionNames,
        functionSources,
        otherTopLevelCode,
    }).join('\n\n');

    if (runtimeDependencySource.trim()) {
        const runtimeDependencyAst = acorn.parse(runtimeDependencySource, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowReturnOutsideFunction: true,
        });
        const runtimeDeps = findDependencies(runtimeDependencyAst, fullEntityMap, allKnownEntities);
        for (const names of runtimeDeps.values()) {
            names.forEach(name => allNeededExports.add(name));
        }
    }

    // --- 4. GENERATE MODULAR FILES ---
    const entitiesByFile = new Map();
    for (const [entity, info] of finalEntityToModuleMap.entries()) {
        if (runtimeEntities.has(entity)) continue;
        if (!entitiesByFile.has(info.path)) entitiesByFile.set(info.path, []);
        entitiesByFile.get(info.path).push(entity);
    }

    const sortedEntitiesByFile = [...entitiesByFile.entries()]
        .sort(([pathA], [pathB]) => pathA.localeCompare(pathB));

    for (const [path, entities] of sortedEntitiesByFile) {
        if (path === runtimePath) continue; // Skip runtime, handle separately

        const fileDependencies = new Map();
        const fileSourceParts = [];
        const sortedEntities = [...entities].sort((a, b) => a.localeCompare(b));

        sortedEntities.forEach(entityName => {
            const node = functionNodes.get(entityName) || classNodes.get(entityName);
            const source = functionSources[entityName] || classSources[entityName];
            if (!source || !node) return;

            const dependencies = findDependencies(node, fullEntityMap, allKnownEntities);
            mergeDependencies(fileDependencies, dependencies, path);

            const shouldExport = allNeededExports.has(entityName);
            let finalSource = source.trim();
            if (shouldExport && !finalSource.startsWith('export ')) {
                finalSource = `export ${finalSource}`;
            }

            fileSourceParts.push(finalSource);
        });

        const importStatements = generateImportStatements(path, fileDependencies);
        const fileContent = `${importStatements}${fileSourceParts.join('\n\n')}`.trim();
        if (fileContent) {
            files[path] = { path, content: fileContent };
        }
    }

    // --- 5. GENERATE CONSOLIDATED RUNTIME & DECOUPLED index.js ---
    const runtimeDependencies = new Map();

    const combinedRuntimeSource = buildRuntimeChunks({
        stateDeclarations,
        domElementDeclarations,
        nonMovableFunctionNames,
        functionSources,
        otherTopLevelCode,
    }).join('\n\n');

    if (combinedRuntimeSource.trim()) {
        const combinedAst = acorn.parse(combinedRuntimeSource, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowReturnOutsideFunction: true,
        });
        const combinedDeps = findDependencies(combinedAst, fullEntityMap, allKnownEntities);
        mergeDependencies(runtimeDependencies, combinedDeps, runtimePath);
    }

    // Determine exports for runtime block
    const runtimeExportNames = [...allNeededExports]
        .filter(name => runtimeEntities.has(name) || nonMovableFunctionNames.has(name))
        .sort((a, b) => a.localeCompare(b));

    const runtimeExports = runtimeExportNames.length > 0
        ? `export { ${runtimeExportNames.join(', ')} };\n\n`
        : '';

    const runtimeImportStatements = generateImportStatements(runtimePath, runtimeDependencies);
    const runtimeContent = `${runtimeImportStatements}${runtimeExports}${combinedRuntimeSource}`.trim() || 'export {};';
    files[runtimePath] = { path: runtimePath, content: runtimeContent };

    const indexImports = new Map();
    indexImports.set(runtimePath, new Set(['*']));

    topLevelCalls.forEach(funcName => {
        const path = fullEntityMap.get(funcName)?.path;
        if (path) {
            if (!indexImports.has(path)) indexImports.set(path, new Set());
            indexImports.get(path).add(funcName);
        }
    });

    const indexImportStatements = generateImportStatements(indexPath, indexImports).trim();
    const topLevelCallCode = topLevelCalls.map(callName => `${callName}();`).join('\n');
    const indexContent = topLevelCallCode
        ? `${indexImportStatements}\n\n// Top-level calls\n${topLevelCallCode}`.trim()
        : indexImportStatements;
    files[indexPath] = { path: indexPath, content: indexContent.trim() };

    return files;
}