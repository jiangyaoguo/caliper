/**
* Copyright 2017 HUAWEI. All Rights Reserved.
*
* SPDX-License-Identifier: Apache-2.0
*
*/

'use strict';

// global variables
const bc   = require('../blockchain.js');
const RateControl = require('../rate-control/rateControl.js');
const Util = require('../util.js');
const log  = Util.log;

let blockchain;
let results      = [];
let txNum        = 0;
let txLastNum    = 0;
let resultStats  = [];
let txUpdateTime = 1000;
let trimType = 0;
let trim = 0;
let startTime = 0;

/**
 * Calculate realtime transaction statistics and send the txUpdated message
 */
function txUpdate() {
    let newNum = txNum - txLastNum;
    txLastNum += newNum;


    let newResults = results.slice(0);
    results = [];
    if(newResults.length === 0 && newNum === 0) {
        return;
    }

    let newStats;
    if(newResults.length === 0) {
        newStats = bc.createNullDefaultTxStats();
    }
    else {
        newStats = blockchain.getDefaultTxStats(newResults, false);
    }
    process.send({type: 'txUpdated', data: {submitted: newNum, committed: newStats}});

    if (resultStats.length === 0) {
        switch (trimType) {
        case 0: // no trim
            resultStats[0] = newStats;
            break;
        case 1: // based on duration
            if (trim < (Date.now() - startTime)/1000) {
                resultStats[0] = newStats;
            }
            break;
        case 2: // based on number
            if (trim < newResults.length) {
                newResults = newResults.slice(trim);
                newStats = blockchain.getDefaultTxStats(newResults, false);
                resultStats[0] = newStats;
                trim = 0;
            } else {
                trim -= newResults.length;
            }
            break;
        }
    } else {
        resultStats[1] = newStats;
        bc.mergeDefaultTxStats(resultStats);
    }
}

/**
 * Add new test result into global array
 * @param {Object} result test result, should be an array or a single JSON object
 */
function addResult(result) {
    if(Array.isArray(result)) { // contain multiple results
        for(let i = 0 ; i < result.length ; i++) {
            results.push(result[i]);
        }
    }
    else {
        results.push(result);
    }
}

/**
 * Call before starting a new test
 * @param {JSON} msg start test message
 */
function beforeTest(msg) {
    results  = [];
    resultStats = [];
    txNum = 0;
    txLastNum = 0;

    // conditionally trim beginning and end results for this test run
    if (msg.trim) {
        if (msg.txDuration) {
            trimType = 1;
        } else {
            trimType = 2;
        }
        trim = msg.trim;
    } else {
        trimType = 0;
    }
}

/**
 * Callback for new submitted transaction(s)
 * @param {Number} count count of new submitted transaction(s)
 */
function submitCallback(count) {
    txNum += count;
}

/**
 * Perform test with specified number of transactions
 * @param {JSON} msg start test message
 * @param {Object} cb callback module
 * @param {Object} context blockchain context
 * @return {Promise} promise object
 */
async function runFixedNumber(msg, cb, context) {
    log('Info: client ' + process.pid +  ' start test runFixedNumber()' + (cb.info ? (':' + cb.info) : ''));
    let rateControl = new RateControl(msg.rateControl, blockchain);
    rateControl.init(msg);

    await cb.init(blockchain, context, msg.args);
    startTime = Date.now();

    let promises = [];
    while(txNum < msg.numb) {
        promises.push(cb.run().then((result) => {
            addResult(result);
            return Promise.resolve();
        }));
        await rateControl.applyRateControl(startTime, txNum, results);
    }

    await Promise.all(promises);
    await rateControl.end();
    return await blockchain.releaseContext(context);
}

/**
 * Perform test with specified test duration
 * @param {JSON} msg start test message
 * @param {Object} cb callback module
 * @param {Object} context blockchain context
 * @return {Promise} promise object
 */
async function runDuration(msg, cb, context) {
    log('Info: client ' + process.pid +  ' start test runDuration()' + (cb.info ? (':' + cb.info) : ''));
    let rateControl = new RateControl(msg.rateControl, blockchain);
    rateControl.init(msg);
    const duration = msg.txDuration; // duration in seconds

    await cb.init(blockchain, context, msg.args);
    startTime = Date.now();

    let promises = [];
    while ((Date.now() - startTime)/1000 < duration) {
        promises.push(cb.run().then((result) => {
            addResult(result);
            return Promise.resolve();
        }));
        await rateControl.applyRateControl(startTime, txNum, results);
    }

    await Promise.all(promises);
    await rateControl.end();
    return await blockchain.releaseContext(context);
}

/**
 * Perform the test
 * @param {JSON} msg start test message
 * @return {Promise} promise object
 */
function doTest(msg) {
    log('doTest() with:', msg);
    let cb = require(Util.resolvePath(msg.cb));
    blockchain = new bc(Util.resolvePath(msg.config));

    beforeTest(msg);
    // start an interval to report results repeatedly
    let txUpdateInter = setInterval(txUpdate, txUpdateTime);
    /**
     * Clear the update interval
     */
    let clearUpdateInter = function () {
        // stop reporter
        if(txUpdateInter) {
            clearInterval(txUpdateInter);
            txUpdateInter = null;
            txUpdate();
        }
    };

    return blockchain.getContext(msg.label, msg.clientargs).then((context) => {
        if(typeof context === 'undefined') {
            context = {
                engine : {
                    submitCallback : submitCallback
                }
            };
        }
        else {
            context.engine = {
                submitCallback : submitCallback
            };
        }
        if (msg.txDuration) {
            return runDuration(msg, cb, context);
        } else {
            return runFixedNumber(msg, cb, context);
        }
    }).then(() => {
        clearUpdateInter();
        return cb.end();
    }).then(() => {
        if (resultStats.length > 0) {
            return Promise.resolve(resultStats[0]);
        }
        else {
            return Promise.resolve(bc.createNullDefaultTxStats());
        }
    }).catch((err) => {
        clearUpdateInter();
        log('Client ' + process.pid + ': error ' + (err.stack ? err.stack : err));
        return Promise.reject(err);
    });
}

/**
 * Message handler
 */
process.on('message', function(message) {
    if(message.hasOwnProperty('type')) {
        try {
            switch(message.type) {
            case 'test': {
                let result;
                doTest(message).then((output) => {
                    result = output;
                    return Util.sleep(200);
                }).then(() => {
                    process.send({type: 'testResult', data: result});
                });
                break;
            }
            default: {
                process.send({type: 'error', data: 'unknown message type'});
            }
            }
        }
        catch(err) {
            process.send({type: 'error', data: err.toString()});
        }
    }
    else {
        process.send({type: 'error', data: 'unknown message type'});
    }
});