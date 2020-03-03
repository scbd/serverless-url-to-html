
const url   = require('url');
const chrome = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const AWS = require('aws-sdk');
const _ = require('lodash');
const minify = require('html-minifier').minify;

let startTime;
let lastCall;

exports.lambdaHandler = async (event, context) => {
    let response;
    let url = event.queryStringParameters.url;

    response = await renderHtml(url);

    return response
}

async function renderHtml(clientUrl){

    startTime = +new Date();
    lastCall = +new Date();
    let response;
    let browser;
    try {        
            
            browser = await puppeteer.launch({
                args: chrome.args,
                executablePath: await chrome.executablePath,
                headless: chrome.headless,
            });

            const page = await browser.newPage();
            await page.setRequestInterception(true);
            log('Page initialized')

            clientUrl = clientUrl.replace(/^\//, '');
            log(`url: ${clientUrl}`)

            let htmlUrl = new url.URL(clientUrl);
            if(!/cbd.int$/.test(htmlUrl.hostname) && !/cbddev.xyz$/.test(htmlUrl.hostname)){
                return {
                    'statusCode': 400,
                    'body': 'Only CBD domain urls can be rendered'
                };
            }
            log('Domain validation passed');
            
            page.on('request', async req => {

                const requestUrl   = req.url();
                const cURL         = new URL(requestUrl);
                const isImg        = req.resourceType() === 'image';
                if(isImg && ~cURL.pathname.indexOf('/api/v2013/documents/')){
                    req.abort();
                }
                else
                    req.continue();
            });
            const stylesheetContents = {};
            let   importStyleSheets  = []
            //copy local stylesheets to inline (to avoid multiple http calls for google index).
            page.on('response', async resp => {
                try{
                    var resStatus = resp.status();
                    if(resStatus != 200)
                        return;

                    const responseUrl   = resp.url();
                    const cssURL        = new URL(responseUrl);
                    const isStylesheet  = resp.request().resourceType() === 'stylesheet';
                    if (isStylesheet) {
                        stylesheetContents[responseUrl] = await resp.text();
    
                        if(/cbd.int$/.test(cssURL.origin)){
                            let regex = /^@import url\((?:"|')(.*)(?:"|')\)(?:;)?$/igm
                            let imports = stylesheetContents[responseUrl].match(regex);
                            if(imports && imports.length>0){
                                _.each(imports, (u)=>{
                                    let urlMatches = u.match(/^@import url\((?:"|')(.*)(?:"|')\)(?:;)?$/);
                                    let cssUrl = urlMatches[1].replace(/\.\.\//g, '');
                                    let css = {
                                        url: cssUrl,
                                        originalString: u, baseCss:responseUrl
                                    };
                                    importStyleSheets.push(css);                   
                                })
                            }
                        }
                    }
                }
                catch(err){
                    // console.log(err, resp)
                }
            });

            //set X-Is-Prerender to avoid iscrawler check since headless userAgent is also consider crawler
            await page.setExtraHTTPHeaders({'X-Is-Prerender': 'true'})

            let pdfOpts = {waitUntil : 'networkidle0', timeout:0}
            await page.goto(clientUrl, pdfOpts);
            log('finished goto');

            // await page.setViewport({ width: 1920, height: 1001 });
            // log('viewport set');
           
            // Replace stylesheets in the page with their equivalent <style>.
            await page.$$eval('link[rel="stylesheet"]', (links, content) => {
                links.forEach(link => {
                const cssText = content[link.href];
                if (cssText) {
                    const style = document.createElement('style');
                    style.textContent = cssText;
                    link.replaceWith(style);
                }
                });
            }, stylesheetContents);
            log('Done combining stylesheets');

            let pageContent = await page.content();

            _.each(importStyleSheets, (style)=>{
                var newKey = _.findKey(stylesheetContents, (key, a)=>{
                                return ~a.indexOf(style.url)
                            });
                var css = stylesheetContents[newKey]
                pageContent = pageContent.replace(style.originalString, css);
 
            });
            log('Done combining import stylesheets');

            log(`page content received, length : ${pageContent.length}(${formatBytes(pageContent.length)})`)
            
            pageContent = removeScriptTags(pageContent);
            log('remove script end');

            
            if(pageContent.length < 5800000){
                pageContent = minimizeHtml(pageContent);
                log('minimize end');
            }
            ////////////////////////////////
            /// Since there is a Lambda response limit of 6MB upload content to S3 and 302 to the S3 file
            ////////////////////////////////
            if(pageContent.length < 5800000){ //5.8 MB
                response = {
                    'statusCode': 200,
                    'headers'   : {"Content-Type": "text/html"},
                    'body'      : pageContent
                }
            }
            else{
                log('response larger than 5.8 mb, saving to s3...')
                const S3_BUCKET = 'pdf-cache-prod';
                let key = 'html-files/' +guid() + '.html';
                
                let s3Options =  {
                    Bucket      : S3_BUCKET, 
                    Key         : key,
                    ContentType : 'text/html', 
                    Body        : pageContent, 
                    ACL         : 'public-read'
                };
                const S3 = new AWS.S3();
                log('s3 initiated')

                let s3File = await S3.putObject(s3Options).promise();
                log('finish upload', s3File,)

                log(`Total time taken: ${(((+new Date())-startTime)/1000).toFixed(5)} secs`)
                return {
                    statusCode: 302,
                    headers: {
                        "Location": `https://s3.amazonaws.com/${S3_BUCKET}/${s3Options.Key}`
                    },
                    body: null
                }
            }
            
    } catch (err) {
        log(`error in processing request, ${JSON.stringify(err||{msg:'noerror'})}`)
        console.log('error catch', err);
        response = {
            'statusCode': 500,
            'body': err
        };
    }
    finally{
        await browser.close();            
    }
    return response
}


function removeScriptTags(content){

    // code from https://github.com/prerender/prerender/blob/master/lib/plugins/removeScriptTags.js
    var matches = content.toString().match(/<script(?:.*?)>(?:[\S\s]*?)<\/script>/gi);
    for (let i = 0; matches && i < matches.length; i++) {
        if (matches[i].indexOf('application/ld+json') === -1) {
            content = content.toString().replace(matches[i], '');
        }
    }

    //<link rel="import" src=""> tags can contain script tags. Since they are already rendered, let's remove them
    matches = content.toString().match(/<link[^>]+?rel="import"[^>]*?>/i);
    for (let i = 0; matches && i < matches.length; i++) {
        content = content.toString().replace(matches[i], '');
    }

    //remove comments
    // content = content.replace(/(<!--.*?-->)|(<!--[\w\W\n\s]+?-->)/gm, '')
    
    return content;
}

function minimizeHtml(content){
    try{

        let options = {
            "caseSensitive": false,
            "collapseBooleanAttributes": true,
            "collapseInlineTagWhitespace": false,
            "collapseWhitespace": true,
            "conservativeCollapse": false,
            "decodeEntities": true,
            "html5": true,
            "includeAutoGeneratedTags": false,
            "keepClosingSlash": false,
            "minifyCSS": true,
            "minifyJS": true,
            "preserveLineBreaks": false,
            "preventAttributesEscaping": false,
            "processConditionalComments": true,
            "processScripts": ["text/html"],
            "removeAttributeQuotes": false,
            "removeComments": true,
            "removeEmptyAttributes": true,
            "removeEmptyElements": false,
            "removeOptionalTags": true,
            "removeRedundantAttributes": true,
            "removeScriptTypeAttributes": false,
            "removeStyleLinkTypeAttributes": false,
            "removeTagWhitespace": true,
            "sortAttributes": false,
            "sortClassName": false,
            "trimCustomFragments": true,
            "useShortDoctype": true
        };
        
        let orignalLength = content.length;
        content = minify(content, options);

        var diff = orignalLength - content.length;
        var savings = orignalLength ? (100 * diff / orignalLength).toFixed(2) : 0;
        
        log(`Original: ${formatBytes(orignalLength)}, minified: ${formatBytes(content.length)}, savings: ${savings}% (${formatBytes(diff)})`);
    }
    catch(e){}
    
    return content;

}
function log(message){

    if(process.env.debug){
        console.log(new Date(), message, `${(((+new Date())-lastCall)/1000).toFixed(5)} secs`);
        lastCall = +new Date()
    }

}

function guid(sep) {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    }

    if (sep === undefined)
        sep = '-';

    return s4() + s4() + sep + s4() + sep + s4() + sep + s4() + sep + s4() + s4() + s4();
}

function formatBytes(bytes, decimals, binaryUnits) {
    if(bytes == 0) {
        return '0 Bytes';
    }
    var unitMultiple = (binaryUnits) ? 1024 : 1000; 
    var unitNames = (unitMultiple === 1024) ? // 1000 bytes in 1 Kilobyte (KB) or 1024 bytes for the binary version (KiB)
        ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']: 
        ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    var unitChanges = Math.floor(Math.log(bytes) / Math.log(unitMultiple));
    return parseFloat((bytes / Math.pow(unitMultiple, unitChanges)).toFixed(decimals || 0)) + ' ' + unitNames[unitChanges];
}