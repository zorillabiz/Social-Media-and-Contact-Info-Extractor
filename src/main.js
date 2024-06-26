const Apify = require('apify');
const { normalizeUrls, fromStartUrls } = require('./helpers');
const helpers = require('./helpers');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    if (!input) throw new Error('There is no input!');

    const {
        startUrls,
        proxyConfig,
        sameDomain,
        maxDepth,
        considerChildFrames,
        // These are total (kept naming for backward compatibillity)
        maxRequests,
        maxRequestsPerStartUrl,
        maxRetries,
        handlePageTimeoutSecs,
        navigationTimeoutSecs,
        payload,
    } = input;

    // Object with startUrls as keys and counters as values
    const requestsPerStartUrlCounter = (await Apify.getValue('STATE-REQUESTS-PER-START-URL')) || {};
    if (maxRequestsPerStartUrl) {
        const persistRequestsPerStartUrlCounter = async () => {
            await Apify.setValue('STATE-REQUESTS-PER-START-URL', requestsPerStartUrlCounter);
        };
        setInterval(persistRequestsPerStartUrlCounter, 60000);
        Apify.events.on('migrating', persistRequestsPerStartUrlCounter);
    }

    if (payload) {
        startUrls.length = 0;
        const dataset = await Apify.openDataset(payload.resource.defaultDatasetId);
        await dataset.forEach(async (item) => {
            startUrls.push(item);
        });
    }

    // processing input URLs in case of requestsFromUrl (urls from txt file)
    const processedStartUrls = [];
    for await (const req of fromStartUrls(startUrls)) {
        processedStartUrls.push(req);
    }

    const requestQueue = await Apify.openRequestQueue();
    const requestList = await Apify.openRequestList('start-urls', normalizeUrls(processedStartUrls));

    requestList.requests.forEach((req) => {
        Object.assign(req.userData, {
            depth: 0,
            referrer: null,
            startUrl: req.url,
        });
        //console.log(req.userData);
        if (maxRequestsPerStartUrl) {
            if (!requestsPerStartUrlCounter[req.url]) {
                requestsPerStartUrlCounter[req.url] = {
                    counter: 1,
                    wasLogged: false,
                };
            }
        }
    });

    const proxyConfiguration = await Apify.createProxyConfiguration(proxyConfig);

    // Create the crawler
    const crawlerOptions = {
        requestList,
        requestQueue,
        proxyConfiguration,
        launchContext: {
            useIncognitoPages: true,
            launchOptions: {
                args: ['--ignore-certificate-errors'],
            },
        },
        browserPoolOptions: {
            useFingerprints: true,
        },
        handlePageFunction: async ({ page, request, response }) => {
            log.info(`Processing ${request.url}`);

            // Wait for body tag to load
            await page.waitForSelector('body');

            if (response) {
                if (response.status() != 200) {
                    //throw new Error(`Error status code ${response.status()}`);
                    log.info(`Skipping ${request.url} (${response.status()} status code)`);
                    return;
                }
            } else {
                log.info(`Skipping ${request.url} (no response)`);
                return;
            }

            const blacklist = ['dan.com', 'afternic.com', 'godaddy.com', 'sedo.com', 'aftermarket.pl', 'brandbucket.com', 'buydomains.com', 'cyberfolks.pl', 'domeinenbank.nl', 'dovendi.com', 'dynadot.com', 'forbes.com', 'hugedomains.com', 'mooiedomeinnaam.nl', 'nic.ru', 'nidoma.com', 'premium.pl', 'reg.ru', 'sawbrokers.com', 'timeweb.ru', 'top-domains.ch'];
            if (blacklist.includes(helpers.getDomain(page.url()))) {
                log.info(`Skipping ${request.url} (domain blacklisted)`);
                return;
            }

            // Set enqueue options
            const linksToEnqueueOptions = {
                page,
                requestQueue,
                selector: 'a',
                sameDomain,
                urlDomain: helpers.getDomain(request.url),
                startUrl: request.userData.startUrl,
                userData: request.userData,
                // These options makes the enqueueUrls call stateful. It would be better to refactor this.
                maxRequestsPerStartUrl,
                requestsPerStartUrlCounter,
            };

            // Enqueue all links on the page
            if (typeof maxDepth !== 'number' || request.userData.depth < maxDepth) {
                await helpers.enqueueUrls(linksToEnqueueOptions);
            }

            // Crawl HTML frames
            let frameSocialHandles = {};
            if (considerChildFrames) {
                frameSocialHandles = await helpers.crawlFrames(page);
            }

            // Generate result
            //const { userData: { depth, referrer } } = request;
            const url = page.url();
            const html = await page.content();

            const result = {
                html,
                url,
                domain: helpers.getDomain(url),
                requestUrl: request.url,
            };

            Object.assign(result, request.userData);

            // Extract and save handles, emails, phone numbers
            const socialHandles = Apify.utils.social.parseHandlesFromHtml(html);

            // Merge frames with main
            const mergedSocial = helpers.mergeSocial(frameSocialHandles, socialHandles);
            Object.assign(result, mergedSocial);
            
            // Clean up
            delete result.html;

            // Store results
            await Apify.pushData(result);
        },
        handleFailedRequestFunction: async ({ request }) => {
            log.error(`Request ${request.url} failed 2 times`);
        },
        preNavigationHooks: [
            async ({ page }) => {
                await Apify.utils.puppeteer.blockRequests(page);
            },
        ],
        handlePageTimeoutSecs,
        navigationTimeoutSecs,
    };

    // Limit requests
    if (maxRequests) crawlerOptions.maxRequestsPerCrawl = maxRequests;

    // Limit retries
    if (maxRetries) crawlerOptions.maxRequestRetries = maxRetries;

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler(crawlerOptions);

    // Run crawler
    log.info(`Starting the crawl...`);
    await crawler.run();
    log.info(`Crawl finished`);
});
