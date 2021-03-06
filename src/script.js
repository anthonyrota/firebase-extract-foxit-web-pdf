// Without this "x.EventEmitter is not defined".
// eslint-disable-next-line import/order
const EventEmitter = require('events');
new EventEmitter();
import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import 'promise-polyfill';
import 'whatwg-fetch';
import 'regenerator-runtime/runtime';
import blobStream from 'blob-stream';
import bufferImageSize from 'buffer-image-size';
import fileSaver from 'file-saver';
import { IdleQueue } from 'idlize/IdleQueue.mjs';
import jszip from 'jszip';
import pLimit from 'p-limit';
import pdfkit from 'pdfkit';

async function onFormSubmit(values) {
    const {
        foxitAssetUrl,
        outFileName,
        fontFamily,
        singleCharacterWordPadding,
        imageOnly,
        textOnly,
        imageAndText,
        textOnlyDebugText,
        imageAndTextDebugText,
        onHasPageCount,
        onPageCreated,
        onZipUpdate,
    } = values;

    const requests = [
        imageOnly && 'image_only',
        textOnly && 'text_only',
        imageAndText && 'image_and_text',
        textOnlyDebugText && 'text_only_debug_text',
        imageAndTextDebugText && 'image_and_text_debug_text',
    ].filter(Boolean);

    const pdfRequests = [];
    const results = [];

    requests.forEach((requestType) => {
        const doc = new pdfkit({
            autoFirstPage: false,
            compress: false,
        });
        const requestParameters = {
            doc,
            fontFamily,
            singleCharacterWordPadding,
        };
        pdfRequests.push(requestParameters);
        let name = outFileName;
        switch (requestType) {
            case 'image_only': {
                name += '_Image_only.pdf';
                requestParameters.imageOnly = true;
                break;
            }
            case 'text_only': {
                name += '_Text_only.pdf';
                requestParameters.textOnly = true;
                break;
            }
            case 'image_and_text': {
                name += '.pdf';
                break;
            }
            case 'text_only_debug_text': {
                requestParameters.textOnly = true;
                requestParameters.debugText = true;
                name += '_Text_only_debug_text.pdf';
                break;
            }
            case 'image_and_text_debug_text': {
                requestParameters.debugText = true;
                name += '_Image_and_text_debug_text.pdf';
                break;
            }
        }
        results.push({
            stream: doc.pipe(blobStream()),
            name,
        });
    });

    let error;
    makePdfs({
        foxitAssetUrl,
        pdfs: pdfRequests,
        onHasPageCount,
        onPageCreated,
    }).catch((v) => {
        console.log('error making pdf', error);
        error = { v };
    });

    if (results.length === 1) {
        const { stream, name } = results[0];
        return new Promise((resolve) => {
            stream.on('finish', () => {
                if (error) {
                    return;
                }
                fileSaver.saveAs(stream.toBlob('application/pdf'), name);
                resolve();
            });
        });
    }

    const zip = new jszip();
    const folder = zip.folder(outFileName);

    await Promise.all(
        results.map(
            ({ stream, name }) =>
                new Promise((resolve) => {
                    stream.on('finish', () => {
                        if (error) {
                            return;
                        }
                        folder.file(name, stream.toBlob('application/pdf'));
                        resolve();
                    });
                }),
        ),
    );

    if (error) {
        return;
    }

    const blob = await zip.generateAsync({ type: 'blob' }, onZipUpdate);
    fileSaver.saveAs(blob, outFileName + '.zip');
}

function normalizeRectangle(rectangle) {
    let temp;
    if (rectangle.left > rectangle.right) {
        temp = rectangle.left;
        rectangle.left = rectangle.right;
        rectangle.right = temp;
    }
    if (rectangle.bottom > rectangle.top) {
        temp = rectangle.bottom;
        rectangle.bottom = rectangle.top;
        rectangle.top = temp;
    }
}

async function getTextForPage({ foxitAssetUrl, pageNumber }) {
    const res = await fetch(
        `${foxitAssetUrl}/annotations/page${pageNumber}?formMode=true&password=`,
        { mode: 'cors' },
    );
    if (!res.ok) {
        throw new Error(`bad response ${res.statusText}`);
    }
    const json = await res.json();
    if (json.error !== 0) {
        throw new Error(`response error ${json.error}`);
    }
    const { texts } = JSON.parse(json.TextPageData);
    return texts.map(({ cs: jsonCharacters }) => ({
        characters: jsonCharacters.map((jsonChar) => {
            if (jsonChar.length !== 5) {
                throw new Error('invalid json char');
            }
            const [left, top, width, height, charCode] = jsonChar;
            const char = {
                charRect: {
                    left,
                    top,
                    right: left + width,
                    bottom: top + height,
                },
                charText: String.fromCharCode(charCode),
            };
            normalizeRectangle(char.charRect);
            return char;
        }),
    }));
}

const isArrayBufferSupported = Buffer.from(new Uint8Array([1]).buffer)[0] === 1;

const arrayBufferToBuffer = isArrayBufferSupported
    ? arrayBufferToBufferAsArgument
    : arrayBufferToBufferCycle;

function arrayBufferToBufferAsArgument(arrayBuffer) {
    return Buffer.from(arrayBuffer);
}

function arrayBufferToBufferCycle(arrayBuffer) {
    const buffer = Buffer.alloc(arrayBuffer.byteLength);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; i++) {
        buffer[i] = view[i];
    }
    return buffer;
}

async function getImageForPage({ foxitAssetUrl, pageNumber }) {
    const res = await fetch(`${foxitAssetUrl}/pages/page${pageNumber}`);
    if (!res.ok) {
        throw new Error(`bad response ${res.statusText}`);
    }
    return res.arrayBuffer().then(arrayBufferToBuffer);
}

async function getManifest({ foxitAssetUrl }) {
    const res = await fetch(`${foxitAssetUrl}/manifest`);
    if (!res.ok) {
        throw new Error(`bad response ${res.statusText}`);
    }
    const json = await res.json();
    if (json.error !== 0) {
        throw new Error(`response error ${json.error}`);
    }
    const docInfo = JSON.parse(json.docinfo);
    return {
        pageCount: docInfo.PageCount,
        pagesInfo: docInfo.PagesInfo,
    };
}

const requestLimit = pLimit(50);

async function makePdfs({
    foxitAssetUrl,
    pdfs,
    onHasPageCount,
    onPageCreated,
}) {
    let concurrentP = Promise.resolve();
    const textOpts = {
        lineBreak: false,
        baseline: 'middle',
        characterSpacing: 0,
    };
    const referenceFontSize = 20;
    const manifest = await getManifest({ foxitAssetUrl });
    onHasPageCount(manifest.pageCount);
    const makePage = async (i) => {
        let resolve;
        const cP = concurrentP;
        concurrentP = concurrentP.then(
            () =>
                new Promise((res) => {
                    resolve = res;
                }),
        );
        const noDownloadText = pdfs.every(({ imageOnly }) => imageOnly);
        const [textObjectList, imageBuffer] = await Promise.all([
            noDownloadText
                ? undefined
                : (async () => {
                      console.log('downloading text for page', i);
                      const v = await getTextForPage({
                          foxitAssetUrl,
                          pageNumber: i,
                      });
                      console.log('downloaded text for page', i);
                      return v;
                  })(),
            (async () => {
                console.log('downloading image for page', i);
                const v = await getImageForPage({
                    foxitAssetUrl,
                    pageNumber: i,
                });
                console.log('downloaded image for page', i);
                return v;
            })(),
        ]);
        const imageDimensions = bufferImageSize(imageBuffer);
        await cP;
        console.log('making page', i);
        await Promise.all(
            pdfs.map(
                ({
                    doc,
                    debugText,
                    fontFamily,
                    singleCharacterWordPadding,
                    imageOnly,
                    textOnly,
                }) => {
                    doc.addPage({
                        size: [imageDimensions.width, imageDimensions.height],
                    });
                    if (!textOnly) {
                        doc.image(imageBuffer, 0, 0);
                    }
                    if (imageOnly) {
                        return;
                    }
                    const xScale =
                        imageDimensions.width / manifest.pagesInfo[i].width;
                    const yScale =
                        imageDimensions.height / manifest.pagesInfo[i].height;
                    if (!textOnly) {
                        if (debugText) {
                            doc.fillColor('#ddd');
                            doc.fillOpacity(0.7);
                        } else {
                            doc.fillOpacity(0);
                        }
                    }
                    doc.font(
                        fontFamily !== undefined ? fontFamily : 'Times-Roman',
                    );
                    if (textObjectList.length === 0) {
                        return;
                    }
                    const queue = new IdleQueue();
                    return new Promise((resolve) => {
                        textObjectList.forEach((textObj, textObjIndex) => {
                            queue.pushTask(() => {
                                let wordStartOffset = 0;
                                for (
                                    let i = 0;
                                    i < textObj.characters.length;
                                    i++
                                ) {
                                    let j = i;
                                    for (
                                        ;
                                        j < textObj.characters.length - 1;
                                        j++
                                    ) {
                                        const thisChar =
                                            textObj.characters[j + 1];
                                        if (/\s/.test(thisChar.charText)) {
                                            break;
                                        }
                                    }
                                    let word = '';
                                    let firstChar;
                                    let lastChar;
                                    for (; i <= j; i++) {
                                        const char = textObj.characters[i];
                                        if (/\s/.test(char.charText)) {
                                            continue;
                                        }
                                        if (!firstChar) {
                                            firstChar = char;
                                        }
                                        lastChar = char;
                                        word += char.charText;
                                    }
                                    if (!firstChar) {
                                        continue;
                                    }
                                    const wordWidth =
                                        (lastChar.charRect.right -
                                            firstChar.charRect.left) *
                                        xScale;
                                    const wordHeight =
                                        (firstChar.charRect.top -
                                            firstChar.charRect.bottom) *
                                        yScale;
                                    doc.fontSize(referenceFontSize);
                                    const referenceHeight = Math.max(
                                        doc.heightOfString(
                                            firstChar.charText,
                                            textOpts,
                                        ),
                                        1,
                                    );
                                    const fontSize =
                                        referenceFontSize *
                                        (wordHeight / referenceHeight);
                                    doc.fontSize(fontSize);
                                    const measuredWordWidth = doc.widthOfString(
                                        word,
                                        textOpts,
                                    );
                                    const characterSpacing =
                                        word.length === 1
                                            ? 0
                                            : (wordWidth -
                                                  wordStartOffset -
                                                  measuredWordWidth) /
                                              (word.length - 1);
                                    if (debugText) {
                                        doc.rect(
                                            firstChar.charRect.left * xScale,
                                            imageDimensions.height -
                                                firstChar.charRect.top * xScale,
                                            wordWidth,
                                            wordHeight,
                                        ).stroke('#ddd');
                                    }
                                    doc.text(
                                        word,
                                        wordStartOffset +
                                            firstChar.charRect.left * xScale,
                                        imageDimensions.height -
                                            firstChar.charRect.top * yScale +
                                            wordHeight / 2,
                                        { ...textOpts, characterSpacing },
                                    );
                                    if (
                                        singleCharacterWordPadding !== undefined
                                    ) {
                                        if (word.length === 1) {
                                            wordStartOffset +=
                                                measuredWordWidth *
                                                singleCharacterWordPadding;
                                        } else {
                                            wordStartOffset = 0;
                                        }
                                    }
                                }
                                const isLast =
                                    textObjIndex === textObjectList.length - 1;
                                if (isLast) {
                                    resolve();
                                }
                            });
                        });
                    });
                },
            ),
        );
        onPageCreated(i + 1);
        console.log('created page', i);
        resolve();
    };
    await Promise.all(
        Array.from({ length: manifest.pageCount }, (_, i) =>
            requestLimit(() => makePage(i)),
        ),
    );
    pdfs.forEach(({ doc }) => {
        doc.end();
    });
}

function bindForm() {
    const form = document.querySelector('form');
    if (!form) {
        return;
    }
    const foxitAssetUrlInput = document.getElementById('foxitAssetUrl');
    const outFileNameInput = document.getElementById('outFileName');
    const fontFamilySelect = document.getElementById('fontFamily');
    const singleCharacterWordPaddingInput = document.getElementById(
        'singleCharacterWordPadding',
    );
    const imageAndTextInput = document.getElementById('imageAndText');
    const imageAndTextDebugTextInput = document.getElementById(
        'imageAndTextDebugText',
    );
    const textOnlyInput = document.getElementById('textOnly');
    const textOnlyDebugTextInput = document.getElementById('textOnlyDebugText');
    const imageOnlyInput = document.getElementById('imageOnly');
    const progress1 = document.getElementById('progress1');
    const progressBar1 = document.getElementById('progressBar1');
    const progress2 = document.getElementById('progress2');
    const progressBar2 = document.getElementById('progressBar2');
    fixCheckboxGroup();
    let isProcessingForm = false;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (isProcessingForm) {
            return;
        }
        isProcessingForm = true;
        for (let i = 0; i < form.elements.length; i++) {
            form.elements[i].disabled = true;
        }
        progress1.classList.remove('d-none');
        let pageCount = 0;
        try {
            await onFormSubmit({
                foxitAssetUrl: foxitAssetUrlInput.value,
                outFileName: outFileNameInput.value,
                fontFamily: fontFamilySelect.value,
                // eslint-disable-next-line max-len
                singleCharacterWordPadding: +singleCharacterWordPaddingInput.value,
                imageAndText: imageAndTextInput.checked,
                imageAndTextDebugText: imageAndTextDebugTextInput.checked,
                textOnly: textOnlyInput.checked,
                textOnlyDebugText: textOnlyDebugTextInput.checked,
                imageOnly: imageOnlyInput.checked,
                onHasPageCount(pageCount_) {
                    progressBar1.innerText = '0 / ' + pageCount_ + ' Pages';
                    progressBar1.setAttribute('aria-valuemax', pageCount_);
                    pageCount = pageCount_;
                },
                onPageCreated(pageNumber) {
                    progressBar1.setAttribute('aria-valuenow', pageNumber);
                    progressBar1.style.width =
                        (pageNumber / pageCount) * 100 + '%';
                    progressBar1.innerText =
                        pageNumber + ' / ' + pageCount + ' Pages';
                },
                onZipUpdate({ percent, currentFile }) {
                    console.log('zip update', percent + '%', currentFile);
                    progress2.classList.remove('d-none');
                    progressBar2.setAttribute('aria-valuenow', percent);
                    progressBar2.style.width = percent + '%';
                    progressBar2.innerText =
                        'Zipping Files (' + percent.toFixed(2) + '%)';
                },
            });
        } catch (error) {
            console.log('error while creating pdf', error);
        }
        isProcessingForm = false;
        for (let i = 0; i < form.elements.length; i++) {
            form.elements[i].disabled = false;
        }
        progress1.classList.add('d-none');
        progressBar1.innerText = '';
        progressBar1.setAttribute('aria-valuenow', 0);
        progressBar1.setAttribute('aria-valuemax', 100);
        progressBar1.style.width = 0;
        progress2.classList.add('d-none');
        progressBar2.innerText = '';
        progressBar2.setAttribute('aria-valuenow', 0);
        progressBar2.style.width = 0;
    });
}

function fixCheckboxGroup() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    const checkboxesCount = checkboxes.length;

    function updateCheckboxRequired() {
        let hasChecked = false;
        for (let i = 0; i < checkboxesCount; i++) {
            if (checkboxes[i].checked) {
                hasChecked = true;
                break;
            }
        }
        for (let i = 0; i < checkboxesCount; i++) {
            checkboxes[i].required = !hasChecked;
        }
    }

    for (let i = 0; i < checkboxesCount; i++) {
        checkboxes[i].addEventListener('change', updateCheckboxRequired);
    }

    updateCheckboxRequired();
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        const swPath = '/sw.js';
        navigator.serviceWorker.register(swPath).catch((error) => {
            console.log('service worker registration failed', error);
        });
    }
}

bindForm();
registerServiceWorker();
