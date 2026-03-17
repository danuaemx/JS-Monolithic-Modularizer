function normalizeZipName(zipFileName) {
    const sanitizedName = String(zipFileName ?? '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '-');

    const baseName = sanitizedName || 'modularized-script';
    return baseName.toLowerCase().endsWith('.zip') ? baseName : `${baseName}.zip`;
}

export async function createZip(files, zipFileName = 'modularized-script.zip') {
    const zip = new JSZip();
    Object.values(files).forEach(file => {
        if (file.content.trim()) zip.file(file.path, file.content);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = normalizeZipName(zipFileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
}