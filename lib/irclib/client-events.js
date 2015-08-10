/*
 * This module contains all the logic to determine how incoming events from
 * IRC clients are mapped to events which are passed to the bridge.
 *
 * For example, every connected IRC client will get messages down their TCP
 * stream, but only 1 client should pass this through to the bridge to
 * avoid duplicates. This is typically handled by the MatrixBridge which is a
 * bot whose job it is to be the unique entity to have responsibility for passing
 * these events through to the bridge.
 *
 * However, we support disabling the bridge entirely which means one of the many
 * TCP streams needs to be responsible for passing the message to the bridge.
 * This is done using the following algorithm:
 *   - Create a hash "H" of (prefix, command, command-parameters) (aka the line)
 *   - Does H exist in the "processed" list?
 *      * YES: Was it you who processed H before?
 *          * YES: Process it again (someone sent the same message twice).
 *          *  NO: Ignore this message. (someone else has processed this)
 *      *  NO: Add H to the "processed" list with your client associated with it
 *             (this works without racing because javascript is single-threaded)
 *             and pass the message to the bridge for processing.
 * There are problems with this approach:
 *   - Unbounded memory consumption on the "processed" list.
 *   - Clients who previously "owned" messages disconnecting and not handling
 *     a duplicate messsage.
 * These are fixed by:
 *   - Periodically culling the "processed" list after a time T.
 *   - Checking if the client who claimed a message still has an active TCP
 *     connection to the server. If they do not have an active connection, the
 *     message hash can be "stolen" by another client.
 */
"use strict";
var pool = require("./client-pool");
var actions = require("../models/actions");
var IrcUser = require("../models/users").IrcUser;


module.exports.addHooks = function(client, connInst, callbacks) {
    var server = client.server;

    var createUser = function(nick) {
        return new IrcUser(
            server, nick,
            pool.getBridgedClientByNick(server, nick) !== undefined
        );
    };

    // === Attach bot listeners ===
    if (client.isBot) {
        // make the bot listen for join/parts
        connInst.addListener("part", function(chan, nick, reason, msg) {
            callbacks.onPart(server, createUser(nick), chan, "part");
        });
        connInst.addListener("quit", function(nick, reason, chans, msg) {
            chans = chans || [];
            chans.forEach(function(chan) {
                callbacks.onPart(server, createUser(nick), chan, "quit");
            });
        });
        connInst.addListener("kick", function(chan, nick, by, reason, msg) {
            callbacks.onPart(server, createUser(nick), chan, "kick");
        });
        connInst.addListener("join", function(chan, nick, msg) {
            callbacks.onJoin(server, createUser(nick), chan, "join");
        });
        // bucket names and drain them once per second to avoid flooding
        // the matrix side with registrations / joins
        var namesBucket = [
        //  { chan: <channel>, nick: <nick> }
        ];
        var processingBucket = false;
        var popName = function() {
            var name = namesBucket.pop(); // LIFO but who cares
            if (!name) {
                processingBucket = false;
                return;
            }
            client.log.debug(
                "Pop %s/%s from names bucket (%s remaining)",
                name.nick, name.chan, namesBucket.length
            );
            return callbacks.onJoin(
                server, createUser(name.nick), name.chan, "names"
            );
        };
        var purgeNames = function() {
            var promise = popName();
            if (promise) {
                promise.finally(function() {
                    purgeNames();
                });
            }
        };

        connInst.addListener("names", function(chan, names, msg) {
            if (names) {
                var userlist = Object.keys(names);
                userlist.forEach(function(nick) {
                    namesBucket.push({
                        chan: chan,
                        nick: nick
                    });
                    // var opsLevel = names[nick]; // + @ or empty string
                    // TODO do something with opsLevel
                });
                client.log.info(
                    "NAMEs: Adding %s nicks from %s.", userlist.length, chan
                );
                client.log.debug("Names bucket has %s entries", namesBucket.length);
                if (!processingBucket) {
                    processingBucket = true;
                    purgeNames();
                }
            }
        });
        // listen for mode changes
        connInst.addListener("+mode", function(channel, by, mode, arg) {
            callbacks.onMode(server, channel, by, mode, true, arg);
        });
        connInst.addListener("-mode", function(channel, by, mode, arg) {
            callbacks.onMode(server, channel, by, mode, false, arg);
        });
        connInst.addListener("message", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            callbacks.onMessage(
                server, createUser(from), to,
                actions.irc.createMessage(text)
            );
        });
        connInst.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            if (text.indexOf("ACTION ") === 0) {
                callbacks.onMessage(
                    server, createUser(from), to,
                    actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
        connInst.addListener("notice", function(from, to, text) {
            if (to.indexOf("#") !== 0) { return; }
            if (from) { // ignore server notices
                callbacks.onMessage(
                    server, createUser(from), to,
                    actions.irc.createNotice(text)
                );
            }
        });
        connInst.addListener("topic", function(channel, topic, nick) {
            if (channel.indexOf("#") !== 0) { return; }

            if (nick && nick.indexOf("@") !== -1) {
                var match = nick.match(
                    // https://github.com/martynsmith/node-irc/blob/master/lib/parse_message.js#L26
                    /^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
                );
                if (match) {
                    nick = match[1];
                }
            }
            callbacks.onMessage(
                server, createUser(nick), channel,
                actions.irc.createTopic(topic)
            );
        });
    }

    // === Attach client listeners ===
    if (!client.isBot) {
        // listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        connInst.addListener("message", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            callbacks.onPrivateMessage(
                server, createUser(from), createUser(to),
                actions.irc.createMessage(text)
            );
        });
        connInst.addListener("notice", function(from, to, text) {
            if (!from || to.indexOf("#") === 0) { return; }
            callbacks.onPrivateMessage(
                server, createUser(from), createUser(to),
                actions.irc.createNotice(text)
            );
        });
        connInst.addListener("ctcp-privmsg", function(from, to, text) {
            if (to.indexOf("#") === 0) { return; }
            if (text.indexOf("ACTION ") === 0) {
                callbacks.onPrivateMessage(
                    server, createUser(from), createUser(to),
                    actions.irc.createEmote(
                        text.substring("ACTION ".length)
                    )
                );
            }
        });
    }
};