export function calculateRelativePath(fromPath, toPath) {
    const fromParts = fromPath.split('/').slice(0, -1);
    const toParts = toPath.split('/');
    if (fromParts.join('/') === toParts.slice(0, -1).join('/')) {
        return './' + toParts[toParts.length - 1];
    }
    let commonLength = 0;
    while (commonLength < fromParts.length && commonLength < toParts.length - 1 && fromParts[commonLength] === toParts[commonLength]) {
        commonLength++;
    }
    let up = '../'.repeat(fromParts.length - commonLength);
    let down = toParts.slice(commonLength).join('/');
    let relativePathStr = up + down;
    if (!relativePathStr.startsWith('../') && !relativePathStr.startsWith('./')) {
         return './' + relativePathStr;
    }
    return relativePathStr;
}