import { analyzeAST } from '../features/analyze-a-s-t.js';
import { createClusters } from '../features/create-clusters.js';
import { generateModuleFiles } from '../features/generate-module-files.js';
import { createZip } from '../features/create-zip.js';

export { fileContent, languageSwitcher, setLanguage, processButton, handleModularization, fileInput, handleFile, dropZone };

let currentLang = 'en';

let fileContent = '';

let sourceFileName = '';

const languageSwitcher = document.getElementById('language-switcher');

const processButton = document.getElementById('processButton');

const outputDiv = document.getElementById('output');

const maxFunctionsInput = document.getElementById('max-functions');

const fileInput = document.getElementById('file-input');

const dropZone = document.getElementById('drop-zone');

const dropZoneInitial = document.getElementById('drop-zone-initial');

const dropZoneUploaded = document.getElementById('drop-zone-uploaded');

const uploadedFileName = document.getElementById('uploaded-file-name');

const fileNameDisplay = document.getElementById('file-name-display');

const zipNameInput = document.getElementById('zip-name');

const outputRootInput = document.getElementById('output-root');

const featuresDirInput = document.getElementById('features-dir');

const coreDirInput = document.getElementById('core-dir');

const fileNameStyleInput = document.getElementById('file-name-style');

const hierarchyThresholdInput = document.getElementById('hierarchy-threshold');

const setLanguage = (lang) => {
    currentLang = lang;
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-key]').forEach(el => {
        const key = el.getAttribute('data-lang-key');
        if (translations[lang] && translations[lang][key]) {
            el.innerHTML = translations[lang][key];
        }
    });

    document.querySelectorAll('[data-lang-placeholder]').forEach(el => {
        const key = el.getAttribute('data-lang-placeholder');
        if (translations[lang] && translations[lang][key]) {
            el.setAttribute('placeholder', translations[lang][key]);
        }
    });
};

const interpolateMessage = (template, values) => {
    return Object.entries(values).reduce((current, [key, value]) => {
        return current.replaceAll(`{${key}}`, value);
    }, template);
};

const ensureZipExtension = (zipName) => {
    const normalized = String(zipName ?? '').trim() || 'modularized-script';
    return normalized.toLowerCase().endsWith('.zip') ? normalized : `${normalized}.zip`;
};

const escapeHtml = (value) => {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const createTreeNode = () => ({ directories: new Map(), files: [] });

const buildFileTree = (paths) => {
    const root = createTreeNode();

    paths.forEach(path => {
        const segments = String(path).split('/').filter(Boolean);
        let currentNode = root;

        segments.forEach((segment, index) => {
            const isFile = index === segments.length - 1;
            if (isFile) {
                if (!currentNode.files.includes(segment)) currentNode.files.push(segment);
                return;
            }

            if (!currentNode.directories.has(segment)) {
                currentNode.directories.set(segment, createTreeNode());
            }
            currentNode = currentNode.directories.get(segment);
        });
    });

    return root;
};

const renderFileTreeHtml = (node, depth = 0) => {
    const directories = [...node.directories.entries()].sort(([dirA], [dirB]) => dirA.localeCompare(dirB));
    const files = [...node.files].sort((fileA, fileB) => fileA.localeCompare(fileB));

    if (directories.length === 0 && files.length === 0) return '';

    const containerClass = depth === 0
        ? 'mt-2 space-y-1 text-left text-sm text-slate-800 bg-white/55 rounded-xl p-2 border border-white/80 shadow-sm'
        : 'mt-1 ml-4 space-y-1 text-left text-sm text-slate-800 border-l border-cyan-200/80 pl-2';

    let html = `<ul class="${containerClass}">`;

    directories.forEach(([directoryName, childNode]) => {
        html += `<li><span class="font-semibold">📁 ${escapeHtml(directoryName)}</span>${renderFileTreeHtml(childNode, depth + 1)}</li>`;
    });

    files.forEach(fileName => {
        html += `<li>📄 ${escapeHtml(fileName)}</li>`;
    });

    html += '</ul>';
    return html;
};

const collectFolderPaths = (paths) => {
    const folders = new Set();

    paths.forEach(path => {
        const segments = String(path).split('/').filter(Boolean);
        for (let index = 1; index < segments.length; index++) {
            folders.add(segments.slice(0, index).join('/'));
        }
    });

    return [...folders].sort((pathA, pathB) => pathA.localeCompare(pathB));
};

const isCommonJsExportTarget = (node) => {
    if (!node || node.type !== 'MemberExpression') return false;

    if (
        !node.computed
        && node.object.type === 'Identifier'
        && node.object.name === 'module'
        && node.property.type === 'Identifier'
        && node.property.name === 'exports'
    ) {
        return true;
    }

    if (!node.computed && node.object.type === 'Identifier' && node.object.name === 'exports') {
        return true;
    }

    return node.object.type === 'MemberExpression' && isCommonJsExportTarget(node.object);
};

const runPreValidation = (sourceCode) => {
    const result = {
        ast: null,
        errors: [],
        warnings: [],
    };

    try {
        result.ast = acorn.parse(sourceCode, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: true,
            allowReturnOutsideFunction: true,
        });
    } catch (parseError) {
        result.errors.push(interpolateMessage(translations[currentLang].precheck_error_parse, {
            line: parseError?.loc?.line ?? '?',
            column: parseError?.loc?.column ?? '?',
        }));
        return result;
    }

    const lineCount = String(sourceCode).split(/\r?\n/).length;
    if (lineCount > 2500) {
        result.warnings.push(interpolateMessage(translations[currentLang].precheck_warn_large_file, { lineCount }));
    }

    if ((result.ast.body || []).length > 250) {
        result.warnings.push(interpolateMessage(translations[currentLang].precheck_warn_top_level, {
            statementCount: result.ast.body.length,
        }));
    }

    const preValidationFlags = {
        usesRequire: false,
        usesCommonJsExports: false,
        usesDynamicImport: false,
        usesEval: false,
        usesWithStatement: false,
    };

    acorn.walk.simple(result.ast, {
        CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
                preValidationFlags.usesRequire = true;
            }
            if (node.callee.type === 'Identifier' && node.callee.name === 'eval') {
                preValidationFlags.usesEval = true;
            }
            if (node.callee.type === 'Import') {
                preValidationFlags.usesDynamicImport = true;
            }
        },
        AssignmentExpression(node) {
            if (node.left.type === 'MemberExpression' && isCommonJsExportTarget(node.left)) {
                preValidationFlags.usesCommonJsExports = true;
            }
        },
        WithStatement() {
            preValidationFlags.usesWithStatement = true;
        }
    });

    if (preValidationFlags.usesRequire || preValidationFlags.usesCommonJsExports) {
        result.warnings.push(translations[currentLang].precheck_warn_commonjs);
    }
    if (preValidationFlags.usesDynamicImport) {
        result.warnings.push(translations[currentLang].precheck_warn_dynamic_import);
    }
    if (preValidationFlags.usesEval) {
        result.warnings.push(translations[currentLang].precheck_warn_eval);
    }
    if (preValidationFlags.usesWithStatement) {
        result.warnings.push(translations[currentLang].precheck_warn_with);
    }

    return result;
};

const renderPreValidationIssues = ({ errors = [], warnings = [] }) => {
    const warningSection = warnings.length > 0
        ? `
            <div>
                <p class="font-semibold text-amber-800">${translations[currentLang].precheck_warnings_title}</p>
                <ul class="mt-2 text-sm text-amber-900 space-y-1 bg-amber-50 rounded-xl p-3 border border-amber-100">
                    ${warnings.map(message => `<li>• ${escapeHtml(message)}</li>`).join('')}
                </ul>
            </div>
        `
        : '';

    const errorSection = errors.length > 0
        ? `
            <div>
                <p class="font-semibold text-rose-800">${translations[currentLang].precheck_errors_title}</p>
                <ul class="mt-2 text-sm text-rose-900 space-y-1 bg-rose-50 rounded-xl p-3 border border-rose-100">
                    ${errors.map(message => `<li>• ${escapeHtml(message)}</li>`).join('')}
                </ul>
            </div>
        `
        : '';

    if (!warningSection && !errorSection) return '';

    return `<div class="space-y-3">${errorSection}${warningSection}</div>`;
};

const renderOutputSummary = ({ files, zipFileName, indexEntryPath, validationWarnings = [] }) => {
    const generatedPaths = Object.keys(files).sort((pathA, pathB) => pathA.localeCompare(pathB));
    const folderPaths = collectFolderPaths(generatedPaths);
    const fileTree = renderFileTreeHtml(buildFileTree(generatedPaths));
    const normalizedZipFileName = ensureZipExtension(zipFileName);

    const folderListHtml = folderPaths.length > 0
        ? `<ul class="mt-2 text-left text-sm text-slate-800 space-y-1 bg-white/55 rounded-xl p-2 border border-white/80 shadow-sm">${folderPaths.map(folderPath => `<li>📁 ${escapeHtml(folderPath)}</li>`).join('')}</ul>`
        : `<p class="mt-2 text-sm text-slate-700">${translations[currentLang].no_generated_folders}</p>`;

    const preValidationWarningsHtml = validationWarnings.length > 0
        ? renderPreValidationIssues({ warnings: validationWarnings })
        : '';

    return `
        <div class="aero-surface aero-card space-y-4 text-left bg-white/72 rounded-2xl p-4 border border-white/90">
            <p class="text-emerald-700 font-semibold">${interpolateMessage(translations[currentLang].success_message_1, { fileCount: generatedPaths.length })}</p>
            <p class="text-slate-900"><span class="font-semibold">${translations[currentLang].source_file_label}:</span> ${escapeHtml(sourceFileName || 'input.js')}</p>
            <p class="text-sky-700 font-semibold">${interpolateMessage(translations[currentLang].success_message_zip_ready, { zipName: normalizedZipFileName })}</p>
            ${preValidationWarningsHtml}
            <div>
                <p class="font-semibold text-slate-900">${translations[currentLang].generated_folders_label}</p>
                ${folderListHtml}
            </div>
            <div>
                <p class="font-semibold text-slate-900">${translations[currentLang].generated_files_label}</p>
                ${fileTree}
            </div>
            <p class="text-slate-900">${translations[currentLang].success_message_2}</p>
            <code class="block bg-white text-left p-2 rounded-xl mt-2 text-sm text-slate-900 border border-sky-100 shadow-sm">&lt;script src="./${escapeHtml(indexEntryPath)}" type="module"&gt;&lt;/script&gt;</code>
            <p class="text-xs text-amber-700 font-semibold">${translations[currentLang].server_required_note}</p>
            <div class="pt-2">
                <button id="download-zip-button" type="button" class="aero-button bg-gradient-to-r from-sky-500 via-cyan-500 to-emerald-500 text-white font-semibold py-2 px-5 rounded-xl hover:from-sky-600 hover:to-emerald-600 focus:outline-none focus-within:ring-4 focus-within:ring-sky-300 shadow-md shadow-cyan-200/80">
                    ${translations[currentLang].download_zip_button}
                </button>
                <p class="mt-2 text-xs text-slate-700">${translations[currentLang].success_no_auto_download}</p>
            </div>
        </div>
    `;
};

const getOutputConfiguration = () => {
    const parsedHierarchyThreshold = Number.parseInt(hierarchyThresholdInput.value, 10);

    return {
        zipFileName: (zipNameInput.value || 'modularized-script').trim() || 'modularized-script',
        generationOptions: {
            outputRootDir: (outputRootInput.value || 'src').trim() || 'src',
            featuresDirName: (featuresDirInput.value || 'features').trim() || 'features',
            coreDirName: (coreDirInput.value || 'core').trim() || 'core',
            fileNameStyle: (fileNameStyleInput.value || 'kebab').trim() || 'kebab',
            hierarchyThreshold: Number.isNaN(parsedHierarchyThreshold)
                ? 2
                : Math.max(0, parsedHierarchyThreshold),
        }
    };
};

const handleFile = (file) => {
    fileNameDisplay.textContent = '';
    fileNameDisplay.classList.remove('text-red-600');

    if (file && (file.name.endsWith('.js') || file.type.match('javascript'))) {
        const reader = new FileReader();
        reader.onload = (e) => {
            fileContent = e.target.result;
            sourceFileName = file.name;
            uploadedFileName.textContent = file.name;
            dropZoneInitial.classList.add('hidden');
            dropZoneUploaded.classList.remove('hidden');
            dropZone.classList.add('border-green-500');
            dropZone.classList.remove('border-red-500', 'border-gray-300');
        };
        reader.readAsText(file);
    } else {
        fileContent = '';
        sourceFileName = '';
        dropZoneInitial.classList.remove('hidden');
        dropZoneUploaded.classList.add('hidden');

        if (file) {
            fileNameDisplay.textContent = translations[currentLang].error_invalid_file;
            fileNameDisplay.classList.add('text-red-600');
            dropZone.classList.add('border-red-500');
            dropZone.classList.remove('border-green-500', 'border-gray-300');
        } else {
             dropZone.classList.add('border-gray-300');
             dropZone.classList.remove('border-green-500', 'border-red-500');
        }
    }
};

async function handleModularization() {
    if (!fileContent.trim()) {
        updateOutput(translations[currentLang].error_no_code, 'error');
        return;
    }

    const maxFunctionsPerModule = Math.max(1, Number.parseInt(maxFunctionsInput.value, 10) || 10);
    const { zipFileName, generationOptions } = getOutputConfiguration();
    setLoading(true);

    try {
        updateOutput(translations[currentLang].step_precheck);
        const preValidation = runPreValidation(fileContent);

        if (preValidation.errors.length > 0) {
            updateOutput(renderPreValidationIssues(preValidation), 'error', true);
            return;
        }

        updateOutput(translations[currentLang].step_1);
        const ast = preValidation.ast;

        updateOutput(translations[currentLang].step_2);
        const analysis = analyzeAST(ast, fileContent);
        if (Object.keys(analysis.functionSources).length === 0 && Object.keys(analysis.classSources).length === 0 && analysis.globalVariables.size === 0) {
            throw new Error(translations[currentLang].error_no_modular_code);
        }

        updateOutput(translations[currentLang].step_3);
        const movableFunctions = Object.keys(analysis.functionSources).filter(name => !analysis.nonMovableFunctionNames.has(name));
        const clusters = createClusters(analysis.callGraph, movableFunctions, maxFunctionsPerModule);

        updateOutput(translations[currentLang].step_4);
        const files = generateModuleFiles(clusters, analysis, generationOptions);

        updateOutput(translations[currentLang].step_5);

        const indexEntryPath = Object.keys(files).find(path => path.endsWith('/index.js')) || `${generationOptions.outputRootDir}/index.js`;
        const successMsg = renderOutputSummary({
            files,
            zipFileName,
            indexEntryPath,
            validationWarnings: preValidation.warnings,
        });
        updateOutput(successMsg, 'success', true);

        const downloadZipButton = document.getElementById('download-zip-button');
        if (downloadZipButton) {
            downloadZipButton.onclick = async () => {
                downloadZipButton.disabled = true;
                const originalLabel = downloadZipButton.textContent;
                downloadZipButton.textContent = translations[currentLang].download_zip_processing;

                try {
                    await createZip(files, zipFileName);
                    downloadZipButton.textContent = translations[currentLang].download_zip_done;
                } catch (zipError) {
                    console.error('ZIP Download Error:', zipError);
                    updateOutput(`${translations[currentLang].error_prefix}: ${zipError.message}`, 'error');
                    downloadZipButton.textContent = originalLabel;
                } finally {
                    downloadZipButton.disabled = false;
                }
            };
        }


    } catch (error) {
        console.error('Modularization Error:', error);
        const isParsingError = error && error.name === 'SyntaxError';
        const errorMessage = isParsingError
            ? translations[currentLang].error_parse
            : `${translations[currentLang].error_prefix}: ${error.message}`;
        updateOutput(errorMessage, 'error');
    } finally {
        setLoading(false);
    }
}

function updateOutput(message, type = 'info', isHTML = false) {
     if (isHTML) {
        outputDiv.innerHTML = message;
     } else {
          const colorClass = type === 'error' ? 'text-rose-700' : type === 'success' ? 'text-emerald-700' : 'text-slate-700';
        outputDiv.innerHTML = `<p class="${colorClass} font-semibold">${message}</p>`;
     }
}

function setLoading(isLoading) {
    processButton.disabled = isLoading;
    const buttonText = processButton.querySelector('span');
    if (isLoading) {
        buttonText.innerHTML = `
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        ${translations[currentLang].button_processing}`;
    } else {
        buttonText.innerHTML = translations[currentLang].button_text;
    }
}

const translations = {
    en: {
        title: "JS Monolithic Modularizer",
        subtitle: "Upload your monolithic script, and we'll convert it into a detailed module structure.",
        upload_label: "Upload your .js file here:",
        upload_input_hint: "Input file: upload one monolithic .js source file.",
        upload_action: "Add .js file",
        upload_drag: "or drag and drop",
        upload_success_desc: "File ready to be processed.",
        upload_replace: "Change file",
        max_functions_label: "Max functions per feature cluster:",
        max_functions_desc: "Larger feature groups will be split into more folders.",
        output_customization_title: "Customize output",
        output_customization_desc: "Control naming, folder structure and ZIP export.",
        zip_name_label: "ZIP file name",
        zip_name_desc: "Name of the downloadable ZIP file.",
        zip_name_placeholder: "modularized-script",
        output_root_label: "Output root folder",
        output_root_desc: "Base directory where modules will be generated.",
        output_root_placeholder: "src",
        features_dir_label: "Features folder",
        features_dir_desc: "Directory for generated feature modules.",
        features_dir_placeholder: "features",
        core_dir_label: "Core folder",
        core_dir_desc: "Directory for runtime and class modules.",
        core_dir_placeholder: "core",
        file_name_style_label: "File naming style",
        file_name_style_desc: "How generated module files are named.",
        naming_kebab: "kebab-case",
        naming_snake: "snake_case",
        naming_camel: "camelCase",
        hierarchy_threshold_label: "Hierarchy threshold",
        hierarchy_threshold_desc: "0 disables nested feature folders. 2+ enables hierarchical grouping.",
        button_text: "Analyze & Modularize",
        button_processing: "Processing...",
        generated_output_title: "Generated output (folders and files)",
        generated_output_desc: "After processing, this area shows generated folders/files. ZIP is downloaded only when you click the button.",
        output_placeholder: "Results will appear here...",
        source_file_label: "Uploaded source (.js)",
        generated_folders_label: "Generated folders",
        generated_files_label: "Generated files",
        no_generated_folders: "No folders were generated.",
        success_message_zip_ready: "ZIP ready: {zipName}",
        server_required_note: "Important: modularized files use ES modules and do not run directly from file://. Use a local or remote web server.",
        success_no_auto_download: "Automatic download is disabled. Click the button to download.",
        download_zip_button: "Download ZIP",
        download_zip_processing: "Preparing ZIP...",
        download_zip_done: "Download again",
        precheck_warnings_title: "Pre-validation warnings",
        precheck_errors_title: "Pre-validation errors",
        precheck_error_parse: "Syntax error detected near line {line}, column {column}. Fix it before modularizing.",
        precheck_warn_large_file: "Large file detected ({lineCount} lines). Processing may take longer and output may need manual review.",
        precheck_warn_top_level: "A high number of top-level statements was detected ({statementCount}). Refactoring may be more aggressive.",
        precheck_warn_commonjs: "CommonJS patterns (require/module.exports) were detected. Output is generated as ES modules and may need manual adjustments.",
        precheck_warn_dynamic_import: "Dynamic import() was detected. Dependency mapping may require manual verification.",
        precheck_warn_eval: "eval() usage was detected. This can reduce analysis accuracy.",
        precheck_warn_with: "with statement usage was detected. This can reduce scope analysis accuracy.",
        footer_text: "&copy; 2026 Demo Tool. Built with Acorn, JSZip & Tailwind CSS.",
        success_message_1: "Process complete! {fileCount} files were generated.",
        success_message_2: "Now, just replace your old script tag in your HTML with:",
        error_no_code: "Please upload a JavaScript file.",
        error_no_modular_code: "No modularizable code (functions, classes, or global variables) was found.",
        error_invalid_file: "Invalid file type. Please upload a .js file.",
        error_parse: "The file could not be parsed. Verify syntax before modularizing.",
        error_prefix: "Error",
        step_precheck: "Pre-check - validating input code...",
        step_1: "1/5 - Analyzing source code (AST)...",
        step_2: "2/5 - Building dependency graph...",
        step_3: "3/5 - Applying clustering algorithms...",
        step_4: "4/5 - Generating file structure & refactoring...",
        step_5: "5/5 - Preparing output preview..."
    },
    es: {
        title: "Modularizador de JS Monolítico",
        subtitle: "Sube tu script monolítico y lo convertiremos en una estructura de módulos detallada.",
        upload_label: "Sube tu archivo .js aquí:",
        upload_input_hint: "Archivo de entrada: sube un único archivo fuente monolítico .js.",
        upload_action: "Agregar archivo .js",
        upload_drag: "o arrástralo y suéltalo",
        upload_success_desc: "Archivo listo para ser procesado.",
        upload_replace: "Cambiar archivo",
        max_functions_label: "Máx. de funciones por feature:",
        max_functions_desc: "Los grupos de features más grandes se dividirán en más carpetas.",
        output_customization_title: "Personaliza el output",
        output_customization_desc: "Configura nombres, estructura de carpetas y el ZIP de salida.",
        zip_name_label: "Nombre del archivo ZIP",
        zip_name_desc: "Nombre del ZIP que se descargará.",
        zip_name_placeholder: "modularized-script",
        output_root_label: "Carpeta raíz de salida",
        output_root_desc: "Directorio base donde se generarán los módulos.",
        output_root_placeholder: "src",
        features_dir_label: "Carpeta de features",
        features_dir_desc: "Directorio para los módulos de features generados.",
        features_dir_placeholder: "features",
        core_dir_label: "Carpeta core",
        core_dir_desc: "Directorio para runtime y módulos de clases.",
        core_dir_placeholder: "core",
        file_name_style_label: "Estilo de nombres de archivo",
        file_name_style_desc: "Cómo se nombran los archivos de módulos generados.",
        naming_kebab: "kebab-case",
        naming_snake: "snake_case",
        naming_camel: "camelCase",
        hierarchy_threshold_label: "Umbral jerárquico",
        hierarchy_threshold_desc: "0 desactiva carpetas anidadas. 2+ activa agrupación jerárquica.",
        button_text: "Analizar y Modularizar",
        button_processing: "Procesando...",
        generated_output_title: "Salida generada (carpetas y archivos)",
        generated_output_desc: "Después de procesar, aquí se muestran las carpetas/archivos generados. El ZIP solo se descarga cuando haces clic en el botón.",
        output_placeholder: "Los resultados aparecerán aquí...",
        source_file_label: "Fuente subida (.js)",
        generated_folders_label: "Carpetas generadas",
        generated_files_label: "Archivos generados",
        no_generated_folders: "No se generaron carpetas.",
        success_message_zip_ready: "ZIP listo: {zipName}",
        server_required_note: "Importante: los archivos modularizados usan módulos ES y no se ejecutan directamente desde file://. Usa un servidor web local o remoto.",
        success_no_auto_download: "La descarga automática está desactivada. Haz clic en el botón para descargar.",
        download_zip_button: "Descargar ZIP",
        download_zip_processing: "Preparando ZIP...",
        download_zip_done: "Descargar de nuevo",
        precheck_warnings_title: "Advertencias de prevalidación",
        precheck_errors_title: "Errores de prevalidación",
        precheck_error_parse: "Se detectó un error de sintaxis cerca de la línea {line}, columna {column}. Corrígelo antes de modularizar.",
        precheck_warn_large_file: "Se detectó un archivo grande ({lineCount} líneas). El procesamiento puede tardar más y el resultado puede requerir revisión manual.",
        precheck_warn_top_level: "Se detectó una cantidad alta de sentencias de nivel superior ({statementCount}). La refactorización puede ser más agresiva.",
        precheck_warn_commonjs: "Se detectaron patrones CommonJS (require/module.exports). La salida se genera como módulos ES y puede requerir ajustes manuales.",
        precheck_warn_dynamic_import: "Se detectó import() dinámico. El mapeo de dependencias puede requerir verificación manual.",
        precheck_warn_eval: "Se detectó uso de eval(). Esto puede reducir la precisión del análisis.",
        precheck_warn_with: "Se detectó uso de with. Esto puede reducir la precisión del análisis de scopes.",
        footer_text: "&copy; 2026 Herramienta de Demostración. Creada con Acorn, JSZip y Tailwind CSS.",
        success_message_1: "¡Proceso completado! Se generaron {fileCount} archivos.",
        success_message_2: "Ahora, simplemente reemplaza la etiqueta de tu antiguo script en tu HTML con:",
        error_no_code: "Por favor, sube un archivo JavaScript.",
        error_no_modular_code: "No se encontró código modularizable (funciones, clases o variables globales).",
        error_invalid_file: "Tipo de archivo inválido. Por favor, sube un archivo .js.",
        error_parse: "No se pudo parsear el archivo. Revisa la sintaxis antes de modularizar.",
        error_prefix: "Error",
        step_precheck: "Pre-chequeo - validando código de entrada...",
        step_1: "1/5 - Analizando el código fuente (AST)...",
        step_2: "2/5 - Construyendo grafo de dependencias...",
        step_3: "3/5 - Aplicando algoritmos de clustering...",
        step_4: "4/5 - Generando estructura de archivos y refactorizando...",
        step_5: "5/5 - Preparando vista del output..."
    }
};

languageSwitcher.addEventListener('change', (e) => setLanguage(e.target.value));

processButton.addEventListener('click', handleModularization);

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
});

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('bg-white/70'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('bg-white/70'), false);
});

dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]), false);

document.addEventListener('DOMContentLoaded', () => {
    const initialLang = 'en';
    languageSwitcher.value = initialLang;
    setLanguage(initialLang);
});