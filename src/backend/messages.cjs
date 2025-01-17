const { keychain } = require('./crypto.cjs')
const {
    loadKnownTxs, 
    saveHash, 
    saveGroupMsg, 
    messageExists, 
    saveMsg, 
    saveThisContact, 
    getConversation, 
    getConversations, 
    getMessages, 
    removeMessages, 
    removeContact, 
    addGroup, 
    removeGroup,
    unBlockContact,
    loadBlockList,
    blockContact,
    getGroupReply,
    printGroup,
    getGroups,
    loadGroups,
    deleteMessage} = require("./database.cjs")
const {
    trimExtra, 
    sanitize_pm_message, 
    parseCall, 
    sleep, 
    hexToUint,
    randomKey,
    nonceFromTimestamp,
    toHex
} = require('./utils.cjs')

const { send_beam_message} = require("./beam.cjs")
const { send_swarm_message } = require("./swarm.cjs")

const { Address, Crypto, CryptoNote} = require('kryptokrona-utils')
const { extraDataToMessage } = require('hugin-crypto')
const { default: fetch } = require('electron-fetch')
const naclUtil = require('tweetnacl-util')
const nacl = require('tweetnacl')
const naclSealed = require('tweetnacl-sealed-box')
const sanitizeHtml = require('sanitize-html')
const crypto = new Crypto()
const xkrUtils = new CryptoNote()
const { ipcMain } = require('electron')
const Store = require('electron-store');
const { Hugin } = require('./account.cjs')
const store = new Store()

let known_pool_txs = []
let known_keys = []
let block_list = []

//IPC MAIN LISTENERS

//MISC

ipcMain.on('optimize', async (e) => {
    optimizeMessages(force = true)
})
//GROUPS MESSAGES

ipcMain.on('sendGroupsMessage', (e, msg, offchain, swarm) => {
    sendGroupsMessage(msg, offchain, swarm)
})

ipcMain.handle('getGroups', async (e) => {
    let groups = await getGroups()
    return groups.reverse()
})

ipcMain.handle('printGroup', async (e, grp) => {
    return await printGroup(grp)
})

ipcMain.handle('getGroupReply', async (e, data) => {
    return await getGroupReply(data)
})

ipcMain.handle('createGroup', async () => {
    return randomKey()
})

ipcMain.on('addGroup', async (e, grp) => {
    addGroup(grp)
    saveGroupMessage(grp, grp.hash, parseInt(Date.now()))
})

ipcMain.on('removeGroup', async (e, grp) => {
    removeGroup(grp)
})

ipcMain.on('unblock', async (e, address) => {
    unBlockContact(address)
    block_list = await loadBlockList()
    Hugin.send('update-blocklist', block_list)
})

ipcMain.on('block', async (e, block) => {
    blockContact(block.address, block.name)
    block_list = await loadBlockList()
    Hugin.send('update-blocklist', block_list)
})

ipcMain.on('deleteMessage', async (e, hash) => {
    deleteMessage(hash)
})

ipcMain.on('deleteMessageAfter', async (e, days) => {
    store.set({
        sql: {
            deleteAfter: days
        }
    })
})


//PRIVATE MESSAGES

ipcMain.handle('getConversations', async (e) => {
    let contacts = await getConversations()
    return contacts.reverse()
})

ipcMain.handle('getMessages', async (data) => {
    return await getMessages()
})

ipcMain.on('sendMsg', (e, msg, receiver, off_chain, grp, beam) => {
    sendMessage(msg, receiver, off_chain, grp, beam)
})

//Listens for event from frontend and saves contact and nickname.
ipcMain.on('addChat', async (e, hugin_address, nickname, first) => {
    saveContact(hugin_address, nickname, first)
})


ipcMain.on('removeContact', (e, contact) => {
    removeContact(contact)
    removeMessages(contact)
    Hugin.send('sent')
})

//WEBRTC MESSAGES

ipcMain.on('decrypt_message', async (e, message) => {
    decryptRtcMessage(message)
})

ipcMain.on('decrypt_rtc_group_message', async (e, message, key) => {
    decryptGroupRtcMessage(message, key)
})


const startMessageSyncer = async () => {
     //Load knownTxsIds to backgroundSyncMessages on startup
    known_keys = Hugin.known_keys
    block_list = Hugin.block_list
     backgroundSyncMessages(await loadCheckedTxs())
     while (true) {
         try {
             //Start syncing
             await sleep(1000 * 10)
 
             backgroundSyncMessages()
 
             const [walletBlockCount, localDaemonBlockCount, networkBlockCount] = await Hugin.wallet.getSyncStatus()

             Hugin.send('node-sync-data', {
                 walletBlockCount,
                 localDaemonBlockCount,
                 networkBlockCount,
             })
 
             if (localDaemonBlockCount - walletBlockCount < 2) {
                 // Diff between wallet height and node height is 1 or 0, we are synced
                 console.log('**********SYNCED**********')
                 console.log('My Wallet ', walletBlockCount)
                 console.log('The Network', networkBlockCount)
                 Hugin.send('sync', 'Synced')
             } else {
                 //If wallet is somehow stuck at block 0 for new users due to bad node connection, reset to the last 100 blocks.
                 if (walletBlockCount === 0) {
                     await Hugin.wallet.reset(networkBlockCount - 100)
                 }
                 console.log('*.[~~~].SYNCING BLOCKS.[~~~].*')
                 console.log('My Wallet ', walletBlockCount)
                 console.log('The Network', networkBlockCount)
                 Hugin.send('sync', 'Syncing')
             }
         } catch (err) {
             console.log(err)
         }
     }
}

async function backgroundSyncMessages(checkedTxs = false) {
    console.log('Background syncing...')
    
    //First start, set known pool txs
    if (checkedTxs) {
        known_pool_txs = await setKnownPoolTxs(checkedTxs)
    }
    
    let transactions = await fetchHuginMessages()
    if (!transactions) return
    decryptHuginMessages(transactions)
}


async function decryptHuginMessages(transactions) {
    for (const transaction of transactions) {
        try {
            let thisExtra = transaction.transactionPrefixInfo.extra
            let thisHash = transaction.transactionPrefixInfotxHash
            if (!validateExtra(thisExtra, thisHash)) continue
            if (thisExtra !== undefined && thisExtra.length > 200) {
                if (!saveHash(thisHash)) continue
                //Check for viewtag
                let checkTag = await checkForViewTag(thisExtra)
                if (checkTag) {
                    await checkForPrivateMessage(thisExtra, thisHash)
                    continue
                }
                //Check for private message //TODO remove this when viewtags are active
                if (await checkForPrivateMessage(thisExtra, thisHash)) continue
                //Check for group message
                if (await checkForGroupMessage(thisExtra, thisHash)) continue
            }
        } catch (err) {
            console.log(err)
        }
    }
}

//Try decrypt extra data
async function checkForPrivateMessage(thisExtra) {
    let message = await extraDataToMessage(thisExtra, known_keys, keychain.getXKRKeypair())
    if (!message) return false
    if (message.type === 'sealedbox' || 'box') {
        message.sent = false
        saveMessage(message)
        return true
    }
}

//Checks the message for a view tag
async function checkForViewTag(extra) {
    try {
    const rawExtra = trimExtra(extra)
    const parsed_box = JSON.parse(rawExtra)
        if (parsed_box.vt) {
            const [privateSpendKey, privateViewKey] = keychain.getPrivKeys()
            const derivation = await crypto.generateKeyDerivation(parsed_box.txKey, privateViewKey);
            const hashDerivation = await crypto.cn_fast_hash(derivation)
            const possibleTag = hashDerivation.substring(0,2)
            const view_tag = parsed_box.vt
            if (possibleTag === view_tag) {
                console.log('**** FOUND VIEWTAG ****')
                return true
            }
        }
    } catch (err) {
    }
    return false
}


//Checks if hugin message is from a group
async function checkForGroupMessage(thisExtra, thisHash) {
    try {
    let group = trimExtra(thisExtra)
    let message = JSON.parse(group)
    if (message.sb) {
            await decryptGroupMessage(message, thisHash)
            return true
    }
    } catch {
        
    }
    return false
}

//Validate extradata, here we can add more conditions
function validateExtra(thisExtra, thisHash) {
    //Extra too long
    if (thisExtra.length > 7000) {
        known_pool_txs.push(thisHash)
        if (!saveHash(thisHash)) return false
        return false;
    }
    //Check if known tx
    if (known_pool_txs.indexOf(thisHash) === -1) {
        known_pool_txs.push(thisHash)
        return true
    } else {
        //Tx already known
        return false
    }
}

async function loadCheckedTxs() {
    
    //Load known pool txs from db.
    let checkedTxs = await loadKnownTxs()
    let arrayLength = checkedTxs.length

    if (arrayLength > 0) {
        checkedTxs = checkedTxs.slice(arrayLength - 200, arrayLength - 1).map(function (knownTX) {
            return knownTX.hash
        })
        
    } else {
        checkedTxs = []
    }

    return checkedTxs
}


//Set known pool txs on start
function setKnownPoolTxs(checkedTxs) {
    //Here we can adjust number of known we send to the node
    known_pool_txs = checkedTxs
    //Can't send undefined to node, it wont respond
    let known = known_pool_txs.filter(a => a !== undefined)
    return known
}


async function fetchHuginMessages() {
    const node = Hugin.node
    try {
        const resp = await fetch(
            'http://' + node.node + ':' + node.port.toString() + '/get_pool_changes_lite',
            {
                method: 'POST',
                body: JSON.stringify({ knownTxsIds: known_pool_txs }),
            }
        )

        let json = await resp.json()
        json = JSON.stringify(json)
            .replaceAll('.txPrefix', '')
            .replaceAll('transactionPrefixInfo.txHash', 'transactionPrefixInfotxHash')

        json = JSON.parse(json)

        let transactions = json.addedTxs
        //Try clearing known pool txs from checked
        known_pool_txs = known_pool_txs.filter((n) => !json.deletedTxsIds.includes(n))
        if (transactions.length === 0) {
            console.log('Empty array...')
            console.log('No incoming messages...')
            return false
        }
        
        return transactions

    } catch (e) {
        Hugin.send('sync', 'Error')
        return false
    }
}


async function sendMessage(message, receiver, off_chain = false, group = false, beam_this = false) {
    //Assert address length
    if (receiver.length !== 163) {
        return
    }
    if (message.length === 0) {
        return
    }
    //Split address and check history
    let address = receiver.substring(0, 99)
    let messageKey = receiver.substring(99, 163)
    let has_history = await checkHistory(messageKey, address)
    if (!beam_this) {
        let balance = await checkBalance()
        if (!balance) return
    }

    let timestamp = Date.now()
    let payload_hex
    if (!has_history) {
        payload_hex = await encryptMessage(message, messageKey, true, address)
    } else {
        payload_hex = await encryptMessage(message, messageKey, false, address)
    }
    //Choose subwallet with message inputs
    let messageWallet = Hugin.wallet.getAddresses()[1]
    let messageSubWallet = Hugin.wallet.getAddresses()[2]

    if (!off_chain) {
        let result = await Hugin.wallet.sendTransactionAdvanced(
            [[messageWallet, 1000]], // destinations,
            3, // mixin
            { fixedFee: 1000, isFixedFee: true }, // fee
            undefined, //paymentID
            [messageWallet, messageSubWallet], // subWalletsToTakeFrom
            undefined, // changeAddresss
            true, // relayToNetwork
            false, // sneedAll
            Buffer.from(payload_hex, 'hex')
        )
        let sentMsg = {
            msg: message,
            k: messageKey,
            sent: true,
            t: timestamp,
            chat: address,
        }
        if (result.success) {
            known_pool_txs.push(result.transactionHash)
            saveHash(result.transactionHash)
            saveMessage(sentMsg)
            optimizeMessages()
        } else {
            let error = {
                message: `Failed to send, please wait a couple of minutes.`,
                name: 'Error',
                hash: Date.now(),
            }
            optimizeMessages(true)
            console.log(`Failed to send transaction: ${result.error.toString()}`)
            Hugin.send('error_msg', error)
        }
    } else if (off_chain) {
        //Offchain messages
        let random_key = randomKey()
        let sentMsg = Buffer.from(payload_hex, 'hex')
        let sendMsg = random_key + '99' + sentMsg
        let messageArray = []
        messageArray.push(sendMsg)
        messageArray.push(address)
        if (group) {
            messageArray.push('group')
        }
        if (beam_this) {
            send_beam_message(sendMsg, address)
        } else {
            Hugin.send('rtc_message', messageArray)
        }
        //Do not save invite message.
        if (message.msg && 'invite' in message.msg) {
            return
        } 
        else {
            let saveThisMessage = {
                msg: message,
                k: messageKey,
                sent: true,
                t: timestamp,
                chat: address,
            }
            saveMessage(saveThisMessage, true)
        }
    }
}

async function optimizeMessages(force = false) {

    let [mainWallet, subWallet, messageSubWallet] = Hugin.wallet.getAddresses()
    const [walletHeight, localHeight, networkHeight] = await Hugin.wallet.getSyncStatus()

    let inputs = await Hugin.wallet.subWallets.getSpendableTransactionInputs(
        [subWallet, messageSubWallet],
        networkHeight
    )

    if (inputs.length > 25 && !force) {
        Hugin.send('optimized', true)
        return
    }

    if (store.get('wallet.optimized')) {
        return
    }

    let subWallets = Hugin.wallet.subWallets.subWallets
    let txs
    subWallets.forEach((value, name) => {
        txs = value.unconfirmedIncomingAmounts.length
    })

    let payments = []
    let i = 0
    /* User payment */
    while (i <= 49) {
        payments.push([messageSubWallet, 1000])
        i += 1
    }

    let result = await Hugin.wallet.sendTransactionAdvanced(
        payments, // destinations,
        3, // mixin
        { fixedFee: 1000, isFixedFee: true }, // fee
        undefined, //paymentID
        [mainWallet], // subWalletsToTakeFrom
        undefined, // changeAddress
        true, // relayToNetwork
        false, // sneedAll
        undefined
    )

    if (result.success) {
        Hugin.send('optimized', true)

        store.set({
            wallet: {
                optimized: true
            }
        });

        resetOptimizeTimer()

        let sent = {
            message: 'Your wallet is creating message inputs, please wait',
            name: 'Optimizing',
            hash: parseInt(Date.now()),
            key: mainWallet,
            optimized: true
        }

        Hugin.send('sent_tx', sent)
        console.log('optimize completed')
        return true
    } else {

        store.set({
            wallet: {
                optimized: false
            }
        });

        Hugin.send('optimized', false)
        let error = {
            message: 'Optimize failed',
            name: 'Optimizing wallet failed',
            hash: parseInt(Date.now()),
            key: mainWallet,
        }
        Hugin.send('error_msg', error)
        return false
    }

}

async function resetOptimizeTimer() {
    await sleep(600 * 1000)
    store.set({
        wallet: {
            optimized: false
        }
    });
}


async function encryptMessage(message, messageKey, sealed = false, toAddr) {
    let timestamp = Date.now()
    let my_address = Hugin.wallet.getPrimaryAddress()
    const addr = await Address.fromAddress(toAddr)
    const [privateSpendKey, privateViewKey] = keychain.getPrivKeys()
    let xkr_private_key = privateSpendKey
    let box

    //Create the view tag using a one time private key and the receiver view key
    const keys = await crypto.generateKeys();
    const toKey = addr.m_keys.m_viewKeys.m_publicKey
    const outDerivation = await crypto.generateKeyDerivation(toKey, keys.private_key);
    const hashDerivation = await crypto.cn_fast_hash(outDerivation)
    const viewTag = hashDerivation.substring(0,2)

    if (sealed) {

        let signature = await xkrUtils.signMessage(message, xkr_private_key)
        let payload_json = {
            from: my_address,
            k: Buffer.from(keychain.getKeyPair().publicKey).toString('hex'),
            msg: message,
            s: signature,
        }
        let payload_json_decoded = naclUtil.decodeUTF8(JSON.stringify(payload_json))
        box = new naclSealed.sealedbox(
            payload_json_decoded,
            nonceFromTimestamp(timestamp),
            hexToUint(messageKey)
        )
    } else if (!sealed) {
        console.log('Has history, not using sealedbox')
        let payload_json = { from: my_address, msg: message }
        let payload_json_decoded = naclUtil.decodeUTF8(JSON.stringify(payload_json))

        box = nacl.box(
            payload_json_decoded,
            nonceFromTimestamp(timestamp),
            hexToUint(messageKey),
            keychain.getKeyPair().secretKey
        )
    }
    //Box object
    let payload_box = { box: Buffer.from(box).toString('hex'), t: timestamp, txKey: keys.public_key, vt: viewTag  }
    // Convert json to hex
    let payload_hex = toHex(JSON.stringify(payload_box))

    return payload_hex
}


async function sendGroupsMessage(message, offchain = false, swarm = false) {
    console.log("Sending group msg!")
    if (message.m.length === 0) return
    const my_address = message.k
    const [privateSpendKey, privateViewKey] = keychain.getPrivKeys()
    const signature = await xkrUtils.signMessage(message.m, privateSpendKey)
    const timestamp = parseInt(Date.now())
    const nonce = nonceFromTimestamp(timestamp)

    let group
    let reply = ''

    group = message.g
    
    if (group === undefined) return
    if (group.length !== 64) {
        return
    }

    if (!offchain) {
        let balance = await checkBalance()
        if (!balance) return
    }
 
    let message_json = {
        m: message.m,
        k: my_address,
        s: signature,
        g: group,
        n: message.n,
        r: reply,
    }

    if (message.r) {
        message_json.r = message.r
    }

    if (message.c) {
        message_json.c = message.c
    }

    let [mainWallet, subWallet, messageSubWallet] = Hugin.wallet.getAddresses()
    const payload_unencrypted = naclUtil.decodeUTF8(JSON.stringify(message_json))
    const secretbox = nacl.secretbox(payload_unencrypted, nonce, hexToUint(group))

    const payload_encrypted = {
        sb: Buffer.from(secretbox).toString('hex'),
        t: timestamp,
    }

    const payload_encrypted_hex = toHex(JSON.stringify(payload_encrypted))

    if (!offchain) {
        let result = await Hugin.wallet.sendTransactionAdvanced(
            [[messageSubWallet, 1000]], // destinations,
            3, // mixin
            { fixedFee: 1000, isFixedFee: true }, // fee
            undefined, //paymentID
            [subWallet, messageSubWallet], // subWalletsToTakeFrom
            undefined, // changeAddress
            true, // relayToNetwork
            false, // sneedAll
            Buffer.from(payload_encrypted_hex, 'hex')
        )

        if (result.success) {
            console.log("Succces sending tx")
            message_json.sent = true
            saveGroupMessage(message_json, result.transactionHash, timestamp)
            Hugin.send('sent_group', {
                hash: result.transactionHash,
                time: message.t,
            })
            known_pool_txs.push(result.transactionHash)
            saveHash(result.transactionHash)
            optimizeMessages()
        } else {
            let error = {
                message: 'Failed to send, please wait a couple of minutes.',
                name: 'Error',
                hash: Date.now(),
            }
            Hugin.send('error_msg', error)
            console.log(`Failed to send transaction: ${result.error.toString()}`)
            optimizeMessages(true)
        }
    } else if (offchain) {
        //Generate a random hash
        let random_key = randomKey()
        let sentMsg = Buffer.from(payload_encrypted_hex, 'hex')
        let sendMsg = random_key + '99' + sentMsg
        message_json.sent = true
        if (swarm) {
            send_swarm_message(sendMsg, group)
            saveGroupMessage(message_json, random_key, timestamp, false, true)
            Hugin.send('sent_rtc_group', {
                hash: random_key,
                time: message.t,
            })
            return
        }
        let messageArray = [sendMsg]
        Hugin.send('rtc_message', messageArray, true)
        Hugin.send('sent_rtc_group', {
            hash: random_key,
            time: message.t,
        })
        
    }
}


async function decryptRtcMessage(message) {
    let hash = message.substring(0, 64)
    let newMsg = await extraDataToMessage(message, known_keys, keychain.getXKRKeypair())

    if (newMsg) {
        newMsg.sent = false
    }
    
    let group = newMsg.msg.msg

    if (group && 'key' in group) {
            if (group.key === undefined) return 
            let invite_key = sanitizeHtml(group.key)
            if (invite_key.length !== 64) return

            Hugin.send('group-call', {invite_key, group})

            if (group.type == 'invite') {
                console.log('Group invite, thanks.')
                return
            }

            sleep(100)

            let video = false
            if (group.type === true) {
                video = true
            }

            let invite = true
            group.invite.forEach((call) => {
                let contact = sanitizeHtml(call)
                if (contact.length !== 163) {
                    Hugin.send('error-notify-message', 'Error reading invite address')
                }
                console.log('Invited to call, joining...')
                Hugin.send('start-call', contact, video, invite)
                sleep(1500)
            })

            return

        } else {
            console.log('Not an invite')
        }

    if (!newMsg) return

    saveMessage(newMsg, true)
}


async function syncGroupHistory(timeframe, recommended_api, key=false, page=1) {
    if (recommended_api === undefined) return
    fetch(`${recommended_api.url}/api/v1/posts-encrypted-group?from=${timeframe}&to=${Date.now() / 1000}&size=50&page=` + page)
    .then((response) => response.json())
    .then(async (json) => {
        console.log(timeframe + " " + key)
        const items = json.encrypted_group_posts;

        for (message in items) {   
            try {
                    let tx = {}
                    tx.sb = items[message].tx_sb
                    tx.t = items[message].tx_timestamp
                    await decryptGroupMessage(tx, items[message].tx_hash, key)
                        
                }
                 catch {
                }
        }
        if(json.current_page != json.total_pages) {
            syncGroupHistory(timeframe, recommended_api, key, page+1)
        }
    })
}

async function decryptGroupMessage(tx, hash, group_key = false) {

    try {
    let decryptBox = false
    let offchain = false
    let groups = await loadGroups()
    
    if (group_key.length === 64) {
        let msg = tx
        tx = JSON.parse(trimExtra(msg))
        groups.unshift({ key: group_key })
        offchain = true
    }

    let key

    let i = 0

    while (!decryptBox && i < groups.length) {
        let possibleKey = groups[i].key

        i += 1

        try {
            decryptBox = nacl.secretbox.open(
                hexToUint(tx.sb),
                nonceFromTimestamp(tx.t),
                hexToUint(possibleKey)
            )

            key = possibleKey
        } catch (err) {
        }
    }

    if (!decryptBox) {
        return false
    }

    const message_dec = naclUtil.encodeUTF8(decryptBox)
    const payload_json = JSON.parse(message_dec)
    const from = payload_json.k
    const this_addr = await Address.fromAddress(from)

    const verified = await xkrUtils.verifyMessageSignature(
        payload_json.m,
        this_addr.spend.publicKey,
        payload_json.s
    )

    if (!verified) return false
    if (block_list.some(a => a.address === from)) return false

    payload_json.sent = false

    let saved = saveGroupMessage(payload_json, hash, tx.t, offchain)
    
    if (!saved) return false

    return [payload_json, tx.t, hash]

    } catch {
        return false
    }
}

async function decryptGroupRtcMessage(message, key) {
    try {
        let hash = message.substring(0, 64)
        let [groupMessage, time, txHash] = await decryptGroupMessage(message, hash, key)

        if (!groupMessage) {
            return
        }
        if (groupMessage.m === 'ᛊNVITᛊ') {
            if (groupMessage.r.length === 163) {
                let invited = sanitizeHtml(groupMessage.r)
                Hugin.send('group_invited_contact', invited)
                console.log('Invited')
            }
        }
    } catch (e) {
        console.log('Not an invite')
    }
}

const checkBalance = async () => {
    try {
        let [munlockedBalance, mlockedBalance] = await Hugin.wallet.getBalance()

        if (munlockedBalance < 11) {
            Hugin.send('error-notify-message', 'Not enough unlocked funds.')
            return false
        }
    } catch (err) {
        return false
    }
    return true
}

async function saveGroupMessage(msg, hash, time, offchain, channel = false) {
    console.log("Savin group message")
    let message = await saveGroupMsg(msg, hash, time, offchain, channel)
    if (!message) return false
    if (!offchain) {
        //Send new board message to frontend.
        Hugin.send('groupMsg', message)
        Hugin.send('newGroupMessage', message)
    } else if (offchain) {
        if (message.message === 'ᛊNVITᛊ') return
        Hugin.send('groupRtcMsg', message)
    }
}


//Saves private message
async function saveMessage(msg, offchain = false) {
    let [message, addr, key, timestamp, sent] = sanitize_pm_message(msg)
    if (!message) return

    if (await messageExists(timestamp)) return
    
    //Checking if private msg is a call
    let [text, data, is_call, if_sent] = parseCall(msg.msg, addr, sent, offchain, timestamp)

    if (text === "Audio call started" || text === "Video call started" && is_call && !if_sent) {
        //Incoming calll
        Hugin.send('call-incoming', data)
    } else if (text === "Call answered" && is_call && !if_sent) {
        //Callback
        Hugin.send('got-callback', data)
    }

    //If sent set addr to chat instead of from
    if (msg.chat && sent) {
        addr = msg.chat
    }

    //New message from unknown contact
    if (msg.type === 'sealedbox' && !sent) {
        let hugin = addr + key
        await saveContact(hugin)
    }

    message = sanitizeHtml(text)
    let newMsg = await saveMsg(message, addr, sent, timestamp, offchain)
    if (sent) {
        //If sent, update conversation list
        Hugin.send('sent', newMsg)
        return
    }
    //Send message to front end
    Hugin.send('newMsg', newMsg)
    Hugin.send('privateMsg', newMsg)
}

//Saves contact and nickname to db.
async function saveContact(hugin_address, nickname = false, first = false) {

    let name
    if (!nickname) {
        name = 'Anon'
    } else {
        name = nickname
    }
    let addr = hugin_address.substring(0, 99)
    let key = hugin_address.substring(99, 163)

    if (known_keys.indexOf(key) == -1) {
        known_keys.push(key)
    }

    saveThisContact(addr, key, name)

    if (first) {
        saveMessage({
            msg: 'New friend added!',
            k: key,
            from: addr,
            chat: addr,
            sent: 1,
            t: Date.now(),
        })
        known_keys.pop(key)
    }

    Hugin.send('saved-addr', hugin_address)
}

async function checkHistory(messageKey, addr) {
    //Check history
    if (known_keys.indexOf(messageKey) > -1) {  
        console.log("Here we go " + addr)
        let [conv] = await getConversation(addr)
        console.log(conv)
        if (parseInt(conv.timestamp) < parseInt(store.get("db.versionDate"))) return false
        return true
    } else {
        known_keys.push(messageKey)
        return false
    }


}

ipcMain.on('fetchGroupHistory', async (e, settings) => {
    let timeframe = Date.now() / 1000 - settings.timeframe * 86400
    //If key is not undefined we know which group to search messages from
    if (settings.key === undefined) settings.key = false
    //Clear known pool txs to look through messages we already marked as known
    known_pool_txs = []
    await syncGroupHistory(timeframe, settings.recommended_api, settings.key)
})

module.exports = {checkHistory, saveMessage, startMessageSyncer, sendMessage, optimizeMessages}