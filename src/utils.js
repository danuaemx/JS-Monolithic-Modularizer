import { calculateRelativePath } from './features/calculate-relative-path.js';

export const toKebabCase = str => str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();

export function findDependencies(node, entityMap, allKnownDeclarations) {
    const dependencies = new Map();
    if(!node) return dependencies;
    acorn.walk.ancestor(node, {
        Identifier(currentNode, state, ancestors) {
            const localScope = new Set();
            for (let i = ancestors.length - 2; i >= 0; i--) {
                const ancestorNode = ancestors[i];
                if (ancestorNode.type === 'FunctionDeclaration' || ancestorNode.type === 'FunctionExpression' || ancestorNode.type === 'ArrowFunctionExpression') {
                   (ancestorNode.params || []).forEach(p => acorn.walk.simple(p, { Identifier(n) { localScope.add(n.name); }}));
                   if (ancestorNode.id) localScope.add(ancestorNode.id.name);
                } else if (ancestorNode.type === 'VariableDeclarator' && ancestorNode.id.type === 'Identifier') {
                    localScope.add(ancestorNode.id.name);
                } else if (ancestorNode.type === 'CatchClause' && ancestorNode.param && ancestorNode.param.type === 'Identifier') {
                    localScope.add(ancestorNode.param.name);
                }
            }

            if (allKnownDeclarations.includes(currentNode.name) && !localScope.has(currentNode.name)) {
                const parent = ancestors[ancestors.length - 2];
                if (!parent || (parent.type === 'MemberExpression' && parent.property === currentNode) || (parent.type === 'Property' && parent.key === currentNode)) return;

                const depInfo = entityMap.get(currentNode.name);
                if (depInfo) {
                    if (!dependencies.has(depInfo.path)) dependencies.set(depInfo.path, new Set());
                    dependencies.get(depInfo.path).add(currentNode.name);
                }
            }
        }
    });
    return dependencies;
}

export function generateImportStatements(currentPath, dependencies) {
    let statements = '';
    const sortedDependencies = [...dependencies.entries()].sort(([pathA], [pathB]) => pathA.localeCompare(pathB));

    for (const [fromPath, names] of sortedDependencies) {
        if (fromPath === currentPath) continue;
        const relativePath = calculateRelativePath(currentPath, fromPath);
        const namedImports = [...names].filter(name => name !== '*').sort();

        if (namedImports.length > 0) {
            statements += `import { ${namedImports.join(', ')} } from '${relativePath}';\n`;
        } else if (names.has('*')) {
            statements += `import '${relativePath}';\n`;
        }
    }
    return statements ? statements + '\n' : '';
}