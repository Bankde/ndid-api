import fetch from 'node-fetch';

import CustomError from '../error/customError';
import errorType from '../error/type';
import logger from '../logger';

import * as tendermint from '../tendermint/ndid';
import * as utils from '../utils';
import * as mq from '../mq';
import * as config from '../config';
import * as common from './common';
import * as db from '../db';

let timeoutScheduler = {};

export function clearAllScheduler() {
  for (let requestId in timeoutScheduler) {
    clearTimeout(timeoutScheduler[requestId]);
  }
}

export async function handleTendermintNewBlockHeaderEvent(
  error,
  result,
  missingBlockCount
) {
  if (missingBlockCount == null) return;

  const height = tendermint.getBlockHeightFromNewBlockHeaderEvent(result);
  const fromHeight =
    missingBlockCount === 0 ? height - 1 : height - missingBlockCount;
  const toHeight = height - 1;
  const blocks = await tendermint.getBlocks(fromHeight, toHeight);
  await Promise.all(
    blocks.map(async (block) => {
      let transactions = tendermint.getTransactionListFromBlockQuery(block);
      await Promise.all(
        transactions.map(async (transaction) => {
          // TODO: clear key with smart-contract, eg. request_id or requestId
          const requestId =
            transaction.args.request_id || transaction.args.requestId; //derive from tx;

          const callbackUrl = await db.getRequestCallbackUrl(requestId);

          if (!callbackUrl) return; // This RP does not concern this request

          // TODO: try catch / error handling
          const request = await common.getRequest({
            requestId,
          });
          const requestDetail = await common.getRequestDetail({
            requestId,
          });
          if (requestDetail.responses == null) {
            requestDetail.responses = [];
          }
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type: 'request_event',
                request_id: requestDetail.request_id,
                status: request.status,
                min_idp: requestDetail.min_idp,
                answered_idp_count: requestDetail.responses.length,
                is_closed: request.is_closed,
                is_timed_out: request.is_timed_out,
                service_list: requestDetail.data_request_list.map(
                  (service) => ({
                    service_id: service.service_id,
                    count: service.count,
                    answered_count:
                      service.answered_as_id_list != null
                        ? service.answered_as_id_list.length
                        : 0,
                  })
                ),
              }),
            });
          } catch (error) {
            logger.error({
              message: 'Cannot send callback to client application',
              error,
            });

            // TODO: error handling
            // retry?
          }

          const idpCountOk =
            requestDetail.responses.length === requestDetail.min_idp;
          if (request.status === 'completed') {
            // Clear callback url mapping, reference ID mapping, and request data to send to AS
            // since the request is no longer going to have further events
            db.removeRequestCallbackUrl(requestId);
            db.removeRequestIdReferenceIdMappingByRequestId(requestId);
            db.removeRequestToSendToAS(requestId);
            db.removeTimeoutScheduler(requestId);
            clearTimeout(timeoutScheduler[requestId]);
            delete timeoutScheduler[requestId];
          } else if (request.status === 'confirmed' && idpCountOk) {
            const requestData = await db.getRequestToSendToAS(requestId);
            if (requestData != null) {
              const height = block.block.header.height;
              /*tendermint.getBlockHeightFromNewBlockHeaderEvent(
            result
          );*/
              // TODO: try catch / error handling
              await sendRequestToAS(requestData, height);
            } else {
              // Authen only, no data request

              // Clear callback url mapping and reference ID mapping
              // since the request is no longer going to have further events
              // (the request has reached its end state)
              db.removeRequestCallbackUrl(requestId);
              db.removeRequestIdReferenceIdMappingByRequestId(requestId);
              db.removeTimeoutScheduler(requestId);
              clearTimeout(timeoutScheduler[requestId]);
              delete timeoutScheduler[requestId];
            }
          } else if (
            request.status === 'rejected' ||
            request.is_closed ||
            request.is_timed_out
          ) {
            // Clear callback url mapping, reference ID mapping, and request data to send to AS
            // since the request is no longer going to have further events
            // (the request has reached its end state)
            db.removeRequestCallbackUrl(requestId);
            db.removeRequestIdReferenceIdMappingByRequestId(requestId);
            db.removeRequestToSendToAS(requestId);
            db.removeTimeoutScheduler(requestId);
            clearTimeout(timeoutScheduler[requestId]);
            delete timeoutScheduler[requestId];
          }
        })
      );
    })
  );
}

async function getASReceiverList(data_request) {
  let nodeIdList;
  if (!data_request.as_id_list || data_request.as_id_list.length === 0) {
    const asNodes = await common.getAsNodesByServiceId({
      service_id: data_request.service_id,
    });
    nodeIdList = asNodes.map((asNode) => asNode.id);
  } else {
    nodeIdList = data_request.as_id_list;
  }

  const receivers = (await Promise.all(
    nodeIdList.map(async (asNodeId) => {
      try {
        //let nodeId = node.node_id;
        let { ip, port } = await common.getMsqAddress(asNodeId);
        return {
          ip,
          port,
          ...(await common.getNodePubKey(asNodeId)),
        };
      } catch (error) {
        return null;
      }
    })
  )).filter((elem) => elem !== null);
  return receivers;
}

async function sendRequestToAS(requestData, height) {
  // node id, which is substituted with ip,port for demo
  let rp_node_id = config.nodeId;
  if (requestData.data_request_list != undefined) {
    requestData.data_request_list.forEach(async (data_request) => {
      let receivers = await getASReceiverList(data_request);
      if (receivers.length === 0) {
        logger.error({
          message: 'No AS found',
          data_request,
        });
        return;
      }

      mq.send(receivers, {
        request_id: requestData.request_id,
        namespace: requestData.namespace,
        identifier: requestData.identifier,
        service_id: data_request.service_id,
        request_params: data_request.request_params,
        rp_node_id: rp_node_id,
        request_message: requestData.request_message,
        height,
      });
    });
  }
}

export async function getIdpsMsqDestination({
  namespace,
  identifier,
  min_ial,
  min_aal,
  idp_list,
}) {
  const idpNodes = await common.getIdpNodes({
    namespace,
    identifier,
    min_ial,
    min_aal,
  });

  let filteredIdpNodes;
  if (idp_list != null && idp_list.length !== 0) {
    filteredIdpNodes = idpNodes.filter(
      (idpNode) => idp_list.indexOf(idpNode.id) >= 0
    );
  } else {
    filteredIdpNodes = idpNodes;
  }

  const receivers = await Promise.all(
    filteredIdpNodes.map(async (idpNode) => {
      const nodeId = idpNode.id;
      const { ip, port } = await common.getMsqAddress(nodeId);
      return {
        ip,
        port,
        ...(await common.getNodePubKey(nodeId)),
      };
    })
  );
  return receivers;
}

/**
 * Create a new request
 * @param {Object} request
 * @param {string} request.namespace
 * @param {string} request.reference_id
 * @param {Array.<string>} request.idp_list
 * @param {string} request.callback_url
 * @param {Array.<Object>} request.data_request_list
 * @param {string} request.request_message
 * @param {number} request.min_ial
 * @param {number} request.min_aal
 * @param {number} request.min_idp
 * @param {number} request.request_timeout
 * @returns {Promise<string>} Request ID
 */
export async function createRequest({
  namespace,
  identifier,
  reference_id,
  idp_list,
  callback_url,
  data_request_list,
  request_message,
  min_ial,
  min_aal,
  min_idp,
  request_timeout,
}) {
  try {
    // existing reference_id, return request ID
    const requestId = await db.getRequestIdByReferenceId(reference_id);
    if (requestId) {
      return requestId;
    }

    if (idp_list != null && idp_list.length > 0 && idp_list.length < min_idp) {
      throw new CustomError({
        message: errorType.IDP_LIST_LESS_THAN_MIN_IDP.message,
        code: errorType.IDP_LIST_LESS_THAN_MIN_IDP.code,
        clientError: true,
        details: {
          namespace,
          identifier,
          idp_list,
        },
      });
    }

    let receivers = await getIdpsMsqDestination({
      namespace,
      identifier,
      min_ial,
      min_aal,
      idp_list,
    });

    if (receivers.length === 0) {
      throw new CustomError({
        message: errorType.NO_IDP_FOUND.message,
        code: errorType.NO_IDP_FOUND.code,
        clientError: true,
        details: {
          namespace,
          identifier,
          idp_list,
        },
      });
    }

    if (receivers.length < min_idp) {
      throw new CustomError({
        message: errorType.NOT_ENOUGH_IDP.message,
        code: errorType.NOT_ENOUGH_IDP.code,
        clientError: true,
        details: {
          namespace,
          identifier,
          idp_list,
        },
      });
    }

    const nonce = utils.getNonce();
    const request_id = utils.createRequestId();

    const dataRequestListToBlockchain = [];
    for (let i in data_request_list) {
      dataRequestListToBlockchain.push({
        service_id: data_request_list[i].service_id,
        as_id_list: data_request_list[i].as_id_list,
        count: data_request_list[i].count,
        request_params_hash: utils.hashWithRandomSalt(
          JSON.stringify(data_request_list[i].request_params)
        ),
      });
    }

    const requestData = {
      namespace,
      identifier,
      request_id,
      min_idp: min_idp ? min_idp : 1,
      min_aal: min_aal,
      min_ial: min_ial,
      request_timeout,
      data_request_list: data_request_list,
      request_message,
    };

    // save request data to DB to send to AS via mq when authen complete
    if (data_request_list != null && data_request_list.length !== 0) {
      await db.setRequestToSendToAS(request_id, requestData);
    }

    // add data to blockchain
    const requestDataToBlockchain = {
      request_id,
      min_idp: min_idp ? min_idp : 1,
      min_aal,
      min_ial,
      request_timeout,
      data_request_list: dataRequestListToBlockchain,
      message_hash: utils.hashWithRandomSalt(request_message),
    };

    const { height } = await tendermint.transact(
      'CreateRequest',
      requestDataToBlockchain,
      nonce
    );

    // send request data to IDPs via message queue
    mq.send(receivers, {
      ...requestData,
      height,
    });

    addTimeoutScheduler(request_id, request_timeout);

    // maintain mapping
    await db.setRequestIdByReferenceId(reference_id, request_id);
    await db.setRequestCallbackUrl(request_id, callback_url);
    return request_id;
  } catch (error) {
    const err = new CustomError({
      message: 'Cannot create request',
      cause: error,
    });
    logger.error(err.getInfoForLog());
    throw err;
  }
}

export async function getRequestIdByReferenceId(referenceId) {
  try {
    return await db.getRequestIdByReferenceId(referenceId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot get data received from AS',
      cause: error,
    });
  }
}

export async function getDataFromAS(requestId) {
  try {
    // Check if request exists
    const request = await common.getRequest({ requestId });
    if (request == null) {
      return null;
    }

    return await db.getDatafromAS(requestId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot get data received from AS',
      cause: error,
    });
  }
}

export async function removeDataFromAS(requestId) {
  try {
    return await db.removeDataFromAS(requestId);
  } catch (error) {
    throw new CustomError({
      message: 'Cannot remove data received from AS',
      cause: error,
    });
  }
}

export async function removeAllDataFromAS() {
  try {
    return await db.removeAllDataFromAS();
  } catch (error) {
    throw new CustomError({
      message: 'Cannot remove all data received from AS',
      cause: error,
    });
  }
}

export async function handleMessageFromQueue(data) {
  logger.info({
    message: 'Received message from MQ',
  });
  logger.debug({
    message: 'Message from MQ',
    data,
  });

  // Verifies signature in blockchain.
  // RP node updates the request status
  // Call callback to RP.

  try {
    const dataJSON = JSON.parse(data);
    const requestDetail = await common.getRequestDetail({
      requestId: dataJSON.request_id,
    });
    // Note: Should check if received request id is expected?

    // TODO: Need to change how BC store data
    // Check if AS signs sent data before request is closed or timed out
    // for (let i = 0; i < requestDetail.data_request_list.length; i++) {
    //   const dataRequest = requestDetail.data_request_list[i];
    //   if (dataRequest.answered_as_id_list.indexOf(dataJSON.as_id) < 0){
    //     return;
    //   }
    // }

    await db.addDataFromAS(dataJSON.request_id, {
      data: dataJSON.data,
      as_id: dataJSON.as_id,
    });
  } catch (error) {
    // TODO: error handling
    throw error;
  }
}

async function timeoutRequest(requestId) {
  try {
    const request = await common.getRequest({ requestId });
    switch (request.status) {
      case 'complicated':
      case 'pending':
      case 'confirmed':
        await tendermint.transact(
          'TimeOutRequest',
          { requestId },
          utils.getNonce()
        );
        break;
      default:
      //Do nothing
    }
  } catch (error) {
    // TODO: error handling
    throw error;
  }
  db.removeTimeoutScheduler(requestId);
}

function runTimeoutScheduler(requestId, secondsToTimeout) {
  if (secondsToTimeout < 0) timeoutRequest(requestId);
  else {
    timeoutScheduler[requestId] = setTimeout(() => {
      timeoutRequest(requestId);
    }, secondsToTimeout * 1000);
  }
}

function addTimeoutScheduler(requestId, secondsToTimeout) {
  let unixTimeout = Date.now() + secondsToTimeout * 1000;
  db.addTimeoutScheduler(requestId, unixTimeout);
  runTimeoutScheduler(requestId, secondsToTimeout);
}

export async function init() {
  let scheduler = await db.getAllTimeoutScheduler();
  scheduler.forEach(({ requestId, unixTimeout }) => {
    runTimeoutScheduler(requestId, (unixTimeout - Date.now()) / 1000);
  });

  //In production this should be done only once in phase 1,

  // Wait for blockchain ready
  await tendermint.ready;

  common.registerMsqAddress(config.mqRegister);
}
