function getPatternIdentifiers(pattern, names = []) {
    if (!pattern) return names;

    switch (pattern.type) {
        case 'Identifier':
            names.push(pattern.name);
            break;
        case 'AssignmentPattern':
            getPatternIdentifiers(pattern.left, names);
            break;
        case 'RestElement':
            getPatternIdentifiers(pattern.argument, names);
            break;
        case 'ArrayPattern':
            (pattern.elements || []).forEach(element => getPatternIdentifiers(element, names));
            break;
        case 'ObjectPattern':
            (pattern.properties || []).forEach(property => {
                if (!property) return;
                if (property.type === 'Property') {
                    getPatternIdentifiers(property.value, names);
                } else if (property.type === 'RestElement') {
                    getPatternIdentifiers(property.argument, names);
                }
            });
            break;
    }

    return names;
}

function buildDeclaratorSource(kind, declarationSource) {
    const source = `${kind} ${declarationSource}`.trim();
    return source.endsWith(';') ? source : `${source};`;
}

function isDomSelectorDeclaration(declaration) {
    if (!declaration || declaration.type !== 'VariableDeclarator' || !declaration.init) return false;
    const init = declaration.init;
    if (init.type !== 'CallExpression' || !init.callee || init.callee.type !== 'MemberExpression') return false;

    const callee = init.callee;
    const objectName = callee.object && callee.object.type === 'Identifier' ? callee.object.name : '';
    const propertyName = callee.property && callee.property.type === 'Identifier' ? callee.property.name : '';

    return objectName === 'document' && (propertyName === 'getElementById' || propertyName === 'querySelector');
}

export function analyzeAST(ast, code) {
    const result = {
        functionSources: {}, classSources: {}, callGraph: {}, topLevelCalls: [],
        globalVariables: new Map(), functionNodes: new Map(), classNodes: new Map(),
        otherTopLevelCode: [],
        scopedVariableNames: new Set(),
        nonMovableFunctionNames: new Set(),
        domElementDeclarations: new Map(),
        stateDeclarations: new Map(),
    };

    ast.body.forEach(statement => {
        if (statement.type === 'FunctionDeclaration' && statement.id) {
            result.functionSources[statement.id.name] = code.substring(statement.start, statement.end);
            result.callGraph[statement.id.name] = [];
            result.functionNodes.set(statement.id.name, statement);
        } else if (statement.type === 'ClassDeclaration' && statement.id) {
            result.classSources[statement.id.name] = code.substring(statement.start, statement.end);
            result.classNodes.set(statement.id.name, statement);
        } else if (statement.type === 'VariableDeclaration') {
            const functionDeclarators = [];
            const classDeclarators = [];
            const variableDeclarators = [];
            const domDeclarators = [];

            statement.declarations.forEach(decl => {
                const isDomElement = isDomSelectorDeclaration(decl);

                if (isDomElement) {
                    domDeclarators.push(decl);
                } else if (decl.init && (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')) {
                    functionDeclarators.push(decl);
                } else if (decl.init && decl.init.type === 'ClassExpression') {
                    classDeclarators.push(decl);
                } else {
                    variableDeclarators.push(decl);
                }
            });

            domDeclarators.forEach(decl => {
                const declSource = buildDeclaratorSource(statement.kind, code.substring(decl.start, decl.end));
                const names = getPatternIdentifiers(decl.id);
                names.forEach(varName => {
                    result.domElementDeclarations.set(varName, declSource);
                    result.scopedVariableNames.add(varName);
                });
            });

            if (variableDeclarators.length > 0) {
                variableDeclarators.forEach(decl => {
                    const declSource = buildDeclaratorSource(statement.kind, code.substring(decl.start, decl.end));
                    const names = getPatternIdentifiers(decl.id);

                    if (statement.kind === 'let') {
                        names.forEach(name => {
                            result.stateDeclarations.set(name, declSource);
                            result.scopedVariableNames.add(name);
                        });
                    } else {
                        result.otherTopLevelCode.push(declSource);
                        names.forEach(name => result.scopedVariableNames.add(name));
                    }
                });
            }

            functionDeclarators.forEach(decl => {
                if (decl.id.type === 'Identifier') {
                    const funcName = decl.id.name;
                    const funcSource = buildDeclaratorSource(statement.kind, code.substring(decl.start, decl.end));
                    result.functionSources[funcName] = funcSource;
                    result.callGraph[funcName] = [];
                    result.functionNodes.set(funcName, decl.init);
                }
            });

            classDeclarators.forEach(decl => {
                 if (decl.id.type === 'Identifier') {
                    const className = decl.id.name;
                    const classSource = buildDeclaratorSource(statement.kind, code.substring(decl.start, decl.end));
                    result.classSources[className] = classSource;
                    result.classNodes.set(className, decl.init);
                }
            });
        } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'Identifier') {
            result.topLevelCalls.push(statement.expression.callee.name);
        } else {
            result.otherTopLevelCode.push(code.substring(statement.start, statement.end));
        }
    });

    for (const [funcName, funcNode] of result.functionNodes.entries()) {
        const functionParamNames = new Set();
        (funcNode.params || []).forEach(param => {
            getPatternIdentifiers(param).forEach(name => functionParamNames.add(name));
        });

        acorn.walk.ancestor(funcNode.body, {
            Identifier(identNode, state, ancestors) {
                if (!result.scopedVariableNames.has(identNode.name)) {
                    return;
                }

                if (functionParamNames.has(identNode.name)) {
                    return;
                }

                if (funcNode.id && funcNode.id.type === 'Identifier' && funcNode.id.name === identNode.name) {
                    return;
                }

                const parent = ancestors[ancestors.length - 2];
                if (parent && ((parent.type === 'MemberExpression' && parent.property === identNode && !parent.computed) || (parent.type === 'Property' && parent.key === identNode))) {
                    return;
                }

                let isShadowed = false;
                for (let i = ancestors.length - 2; i >= 0; i--) {
                    const scopeCandidate = ancestors[i];
                    if (scopeCandidate === funcNode) {
                        if (scopeCandidate.params && scopeCandidate.params.some(p => p.type === 'Identifier' && p.name === identNode.name)) {
                            isShadowed = true;
                        }
                        break;
                    }

                    let declaredHere = false;
                    if (scopeCandidate.type === 'BlockStatement') {
                        for (const statement of scopeCandidate.body) {
                            if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
                                if (statement.declarations.some(d => d.id.type === 'Identifier' && d.id.name === identNode.name)) {
                                    declaredHere = true;
                                    break;
                                }
                            }
                        }
                    } else if (scopeCandidate.type === 'VariableDeclarator') {
                        if (getPatternIdentifiers(scopeCandidate.id).includes(identNode.name)) {
                            declaredHere = true;
                        }
                    } else if (scopeCandidate.type === 'FunctionExpression' || scopeCandidate.type === 'ArrowFunctionExpression' || scopeCandidate.type === 'FunctionDeclaration') {
                        if (scopeCandidate.params && scopeCandidate.params.some(p => getPatternIdentifiers(p).includes(identNode.name))) {
                            declaredHere = true;
                        }
                        if (!declaredHere && scopeCandidate.id && scopeCandidate.id.type === 'Identifier' && scopeCandidate.id.name === identNode.name) {
                            declaredHere = true;
                        }
                    } else if (scopeCandidate.type === 'CatchClause' && scopeCandidate.param) {
                        if (getPatternIdentifiers(scopeCandidate.param).includes(identNode.name)) {
                            declaredHere = true;
                        }
                    }

                    if (declaredHere) {
                        isShadowed = true;
                        break;
                    }
                }

                if (!isShadowed) {
                    result.nonMovableFunctionNames.add(funcName);
                }
            }
        });
    }

    for (const [callerName, funcNode] of result.functionNodes.entries()) {
        acorn.walk.simple(funcNode.body, {
            CallExpression(callNode) {
                if (callNode.callee.type === 'Identifier' && result.functionNodes.has(callNode.callee.name)) {
                    result.callGraph[callerName].push(callNode.callee.name);
                }
            }
        });

        result.callGraph[callerName] = [...new Set(result.callGraph[callerName])];
    }

    result.topLevelCalls = [...new Set(result.topLevelCalls)];
    return result;
}