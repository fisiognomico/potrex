const _ = require('lodash');
const moment = require('moment');
const debug = require('debug')('routes:personal');
const nconf = require('nconf');

const automo = require('../lib/automo');
const params = require('../lib/params');
const CSV = require('../lib/CSV');
const mongo3 = require('../lib/mongo3');

function fixHomeSimply(e) {
    let v = _.get(e, 'sections.videos');
    v.sectionName = e.sections.display;
    v.sectionHref = e.sections.href;
    v.sectionOrder = e.sections.order;
    v.profileStory = e.profileStory;
    v.savingTime = new Date(e.savingTime);
    try {
        v.categories = _.map(_.first(e.categories).categories, 'name');
    } catch(error) {
        debug("Error in accessing categories: %s", error.message);
        v.categories = [ "error-investigate" ];
    }
    v.site = e.site;
    return v;
}

async function getPersonal(req) {
    const k =  req.params.publicKey;
    if(_.size(k) < 26)
        return { json: { "message": "Invalid publicKey", "error": true }};

    const what = req.params.what;
    debug("Asked to get data kind %s, but at the moment only the home is supported", what);

    /* const { amount, skip } = params.optionParsing(req.params.paging, DEFMAX);
    debug("getPersonal: amount %d skip %d, default max %d", amount, skip, DEFMAX); */
    const data = await automo.getSummaryByPublicKey(k, what);
    /* what is ignored at the moment only 'home' is returned, along
       supporter (the person) and total (Int) */

    const formatted = _.map(data.homedata, fixHomeSimply);
    return { json: {
        home: formatted,
        supporter: data.supporter,
        total: data.total
    }};
};

function unNestHome(memo, metadata) {
    const nested = _.map(metadata.sections, function(section) {
        return _.map(section.videos, function(video, o) {
            return {
                sectionOrder: section.order + 1,
                sectionName: section.display,
                videoOrder: o + 1,
                videoTitle: video.title,
                authorName: video.authorName,
                videoId: video.videoId,
                savingTime: metadata.savingTime,
                metadataId: metadata.id,
            }
        })
    });
    return _.concat(memo, _.flatten(nested));
}

async function getPersonalCSV(req) {
    // only HOMEPAGES — /api/v1/personal/:publicKey/csv
    const CSV_MAX_SIZE = 1000;
    const k =  req.params.publicKey;
    const data = await automo.getMetadataByFilter({ publicKey: k, type: 'home'}, { amount: CSV_MAX_SIZE, skip: 0 });
    // get metadata by filter actually return metadata object so we need unnesting
    const unrolledData = _.reduce(data, unNestHome, []);
    const csv = CSV.produceCSVv1(unrolledData);

    debug("getPersonalCSV produced %d bytes from %d homepages (max %d)",
        _.size(csv), _.size(data), CSV_MAX_SIZE);
    if(!_.size(csv))
        return { text: "Data not found: are you sure you've any pornhub homepage acquired?" };

    const filename = 'potrex-homepages-' + moment().format("YY-MM-DD") + ".csv"
    return {
        headers: {
            "Content-Type": "csv/text",
            "Content-Disposition": "attachment; filename=" + filename
        },
        text: csv,
    };
};

async function getUnwindedHomeCSV(req) {
    // /api/v1/homeUnwindedCSV/:amount?
    const CSV_MAX_SIZE = 1000;
    const k =  req.params.publicKey;
    const data = await automo.getMetadataByFilter({ publicKey: k, type: 'home'}, { amount: CSV_MAX_SIZE, skip: 0 });

    // get metadata by filter actually return metadata object so we need unnesting
    const unrolledData = _.reduce(data, unNestHome, []);
    let simplified = [];
    const mongoc = await mongo3.clientConnect({concurrency: 10});
    for (video of unrolledData) {
        const c = await mongo3.readOne(mongoc, nconf.get('schema').categories, { videoId: video.videoId});
        _.each(c ? c.categories: [], function(catentry) { 
            let simpled = _.extend(video, { category: catentry.name });
            simpled.id = video.videoOrder + video.metadataId.substring(0, 7);
            simplified.push(
                _.omit(simpled, ['videoOrder', 'sectionOrder'])
            );
        })
    }
    await mongoc.close();
    const csv = CSV.produceCSVv1(simplified);

    debug("getUnwindedHomeCSV produced %d bytes from %d homepages (max %d)",
        _.size(csv), _.size(data), CSV_MAX_SIZE);

    if(!_.size(csv))
        return { text: "Data not found: are you sure you've any pornhub homepage acquired?" };

    const filename = 'unwinded-' + moment().format("YY-MM-DD") + ".csv"
    return {
        headers: {
            "Content-Type": "csv/text",
            "Content-Disposition": "attachment; filename=" + filename
        },
        text: csv,
    };
}


async function getSubmittedRAW(req) {
    const MAX = 30;
    const k =  req.params.publicKey;

    const htmlFilter = { publicKey: k };
    const stored = await automo.getLastHTMLs(htmlFilter, 0, MAX);
    const trimmed = _.map(stored.content, function(h) {
        return _.pick(h, ['id', 'metadataId', 'size', 'processed', 'href', 'savingTime']);
    })
    return { json: { content: trimmed, amount: MAX, overflow: stored.overflow} };
}

async function getPersonalRelated(req) {
    const DEFMAX = 40;
    const k =  req.params.publicKey;
    if(_.size(k) < 26)
        return { json: { "message": "Invalid publicKey", "error": true }};

    const { amount, skip } = params.optionParsing(req.params.paging, DEFMAX);
    debug("getPersonalRelated request by %s using %d starting videos, skip %d (defmax %d)", k, amount, skip, DEFMAX);
    let related = await automo.getRelatedByWatcher(k, { amount, skip });
    const formatted = _.map(related, function(r) {
        /* this is the same format in youtube.tracking.exposed/data,u
         * and should be in lib + documented */
        return {
            id: r.id,
            videoId: r.related.videoId,
            title: r.related.title,
            source: _.replace(r.related.source, /\n/g, ' ⁞ '),
            vizstr: r.related.vizstr,
            suggestionOrder: r.related.index,
            displayLength: r.related.displayTime,
            watched: r.title,
            since: r.publicationString,
            credited: r.authorName,
            channel: r.authorSource,
            savingTime: r.savingTime,
            watcher: r.watcher,
            watchedId: r.videoId,
        };
    });

    debug("getPersonalRelated produced %d results", _.size(formatted));
    return {
        json: formatted
    };
};

async function getEvidences(req) {
    /* this function is quite generic and flexible. allow an user to query their 
     * own evidences and allow specification of which is the field to be queried.
     * It is used in our interface with 'id' */
    const k =  req.params.publicKey;
    if(_.size(k) < 26)
        return { json: { "message": "Invalid publicKey", "error": true }};

    const allowFields = ['tagId', 'id', 'videoId'];
    const targetKey = req.params.key;
    const targetValue = req.params.value;

    if(allowFields.indexOf(targetKey) == -1)
        return { json: { "message": `Key ${targetKey} not allowed (${allowFields})`, error: true }};

    const matches = await automo.getVideosByPublicKey(k, _.set({}, targetKey, targetValue));
    debug("getEvidences with flexible filter found %d matches", _.size(matches));
    return { json: matches };
};

async function removeEvidence(req) {
    const k =  req.params.publicKey;
    if(_.size(k) < 26)
        return { json: { "message": "Invalid publicKey", "error": true }};

    const id = req.params.id;
    const result = await automo.deleteEntry(k, id);
    debug("Requeste delete of metadataId %s deleted %d video and %d metadata",
        id, _.size(result.videoId), _.size(result.metadata));
    return { json: { success: true, result }};
};


module.exports = {
    getPersonal,
    getSubmittedRAW,
    getPersonalCSV,
    getUnwindedHomeCSV,
    getPersonalRelated,
    getEvidences,
    removeEvidence,
};
