export function createClusters(callGraph, functionNames, maxFunctionsPerModule) {
    const clusters = {};
    let featureCount = 1;
    const inDegree = {};
    const callersByFunction = {};
    const normalizedMaxFunctions = Math.max(1, Number(maxFunctionsPerModule) || 1);

    functionNames.forEach(name => {
        inDegree[name] = 0;
        callersByFunction[name] = new Set();
    });

    Object.entries(callGraph).forEach(([caller, callees]) => {
        (callees || []).forEach(callee => {
            if (inDegree[callee] !== undefined) inDegree[callee]++;
            if (callersByFunction[callee]) callersByFunction[callee].add(caller);
        });
    });

    const utils = functionNames.filter(name => inDegree[name] >= 2).sort((a, b) => a.localeCompare(b));
    const assignedFunctions = new Set(utils);
    if (utils.length > 0) clusters['utils'] = utils;

    const remaining = functionNames
        .filter(name => !assignedFunctions.has(name))
        .sort((a, b) => a.localeCompare(b));
    const remainingSet = new Set(remaining);
    const visited = new Set();

    for (const startNode of remaining) {
        if (visited.has(startNode)) continue;
        const component = new Set([startNode]);
        const queue = [startNode];
        visited.add(startNode);

        while (queue.length > 0) {
            const current = queue.shift();
            const neighbors = new Set([
                ...(callGraph[current] || []),
                ...Array.from(callersByFunction[current] || []),
            ]);

            for (const neighbor of neighbors) {
                if (remainingSet.has(neighbor) && !visited.has(neighbor)) {
                    visited.add(neighbor);
                    component.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        const componentArray = Array.from(component).sort((a, b) => a.localeCompare(b));
        for (let i = 0; i < componentArray.length; i += normalizedMaxFunctions) {
            clusters[`feature${featureCount++}`] = componentArray.slice(i, i + normalizedMaxFunctions);
        }
    }

    return clusters;
}