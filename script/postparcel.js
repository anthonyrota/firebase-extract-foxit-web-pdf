'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const babel = require('@babel/core');
const cpy = require('cpy');
const cssnano = require('cssnano');
const glob = util.promisify(require('glob'));
const postcss = require('postcss');
const purgecss = require('purgecss');
const terser = require('terser');

function makeFileHash(contents) {
    return crypto.createHash('md5').update(contents).digest('hex').slice(-8);
}

async function main() {
    const rootDir = process.cwd();
    const srcDir = path.join(rootDir, 'src');
    const publicDir = path.join(rootDir, 'public');

    await cpy(path.join(srcDir, 'favicon.ico'), publicDir);
    await cpy(path.join(srcDir, 'icons/*'), path.join(publicDir, 'icons'));

    const [manifestPath] = await glob('manifest.*.webmanifest', {
        nodir: true,
        cwd: publicDir,
    });
    const absoluteManifestPath = path.join(publicDir, manifestPath);
    const manifestText = await fs.readFile(absoluteManifestPath, 'utf-8');
    const newManifestName = 'manifest.webmanifest';
    await fs.unlink(absoluteManifestPath);
    await fs.writeFile(
        path.join(publicDir, newManifestName),
        JSON.stringify(JSON.parse(manifestText)),
        'utf-8',
    );

    const [scriptCssPath] = await glob('script.*.css', {
        nodir: true,
        cwd: publicDir,
    });
    const absoluteScriptCssPath = path.join(publicDir, scriptCssPath);
    const purgedCss = (
        await new purgecss.PurgeCSS().purge({
            content: [path.join(publicDir, 'index.html')],
            css: [absoluteScriptCssPath],
            fontFace: true,
            keyframes: true,
            variables: true,
        })
    )[0].css;
    const minifiedCss = (
        await postcss([
            cssnano({
                preset: 'default',
            }),
        ]).process(purgedCss, {
            from: absoluteScriptCssPath,
        })
    ).css;
    const newScriptCssName = `script.${makeFileHash(minifiedCss)}.css`;
    await fs.unlink(absoluteScriptCssPath);
    await fs.writeFile(
        path.join(publicDir, newScriptCssName),
        minifiedCss,
        'utf-8',
    );

    const scriptJsPath = (
        await glob('script.*.js', { nodir: true, cwd: publicDir })
    )[0];
    const iconDirFiles = await glob('icons/*', {
        nodir: true,
        cwd: publicDir,
    });
    const iconReplacements = (
        await Promise.all(
            iconDirFiles.map(async (iconPath) => {
                const ext = path.extname(iconPath);
                const name = path.basename(iconPath, ext);
                const hashed = await glob(`${name}.*${ext}`, {
                    nodir: true,
                    cwd: publicDir,
                });
                if (hashed.length !== 1) {
                    return;
                }
                const [hashedName] = hashed;
                fs.unlink(path.join(publicDir, hashedName));
                return { hashedName, iconPath };
            }),
        )
    ).filter(Boolean);

    for (const htmlPath of await glob('*.html', {
        nodir: true,
        cwd: publicDir,
    })) {
        const absoluteHtmlPath = path.join(publicDir, htmlPath);
        let htmlText = (await fs.readFile(absoluteHtmlPath, 'utf-8'))
            .replace('/' + manifestPath, '/' + newManifestName)
            .replace('/' + scriptCssPath, '/' + newScriptCssName)
            // Parcel bug where the css path is injected instead of the js.
            .replace('/' + scriptCssPath, '/' + scriptJsPath);
        for (const { hashedName, iconPath } of iconReplacements) {
            htmlText = htmlText.replace('/' + hashedName, '/' + iconPath);
        }
        await fs.writeFile(absoluteHtmlPath, htmlText, 'utf-8');
    }

    const immutablePaths = await glob('*.{css,js}', {
        nodir: true,
        cwd: publicDir,
    });
    const iconPaths = ['favicon.ico'].concat(iconDirFiles);

    function makeFileNameAndContentList(fileList) {
        return Promise.all(
            fileList.map(async (filePath) => [
                filePath,
                await fs.readFile(path.join(publicDir, filePath), 'utf-8'),
            ]),
        );
    }

    const cacheName = makeFileHash(
        JSON.stringify({
            staticPaths: await makeFileNameAndContentList(immutablePaths),
            iconPaths: await makeFileNameAndContentList(iconPaths),
        }),
    );

    function joinPathList(paths) {
        return paths.map((path) => '/' + path).join("','");
    }

    const _404Html = await fs.readFile(
        (await glob(path.join(publicDir, '404.html')))[0],
        'utf-8',
    );

    const swSrcPath = path.join(srcDir, 'sw.js');
    const swTranspiled = (
        await babel.transformAsync(
            (await fs.readFile(swSrcPath, 'utf-8'))
                .replace(/::cacheName::/g, cacheName)
                .replace(/::immutablePaths::/g, joinPathList(immutablePaths))
                .replace(/::iconPaths::/g, joinPathList(iconPaths))
                .replace(/'::404Html::'/g, JSON.stringify(_404Html)),
            {
                filename: swSrcPath,
            },
        )
    ).code;
    const swMinified = (
        await terser.minify(swTranspiled, {
            toplevel: true,
        })
    ).code;

    await fs.writeFile(path.join(publicDir, 'sw.js'), swMinified, 'utf-8');
}

main().catch((error) => {
    console.log(error);
    process.exitCode = 1;
});
