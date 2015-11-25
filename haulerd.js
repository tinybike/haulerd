#!/usr/bin/env node

"use strict";

var fs = require("fs");
var p = require("path");
var net = require("net");
var async = require("async");
var inputprompt = require("prompt");
var NeDB = require("nedb");
var spacebox = require("spacebox");
var db = new NeDB({filename: p.join(__dirname, "hauler.db"), autoload: true});

function connect(config) {
    var message = "";
    var socket = net.connect({
        host: "45.33.62.72",
        // host: "localhost",
        port: 9876
    }, function (err) {
        if (err) return console.error("net.connect:", err);
        console.log("Connected to server.");
        if (config && config.handle) {
            socket.write(JSON.stringify({
                label: "identify",
                handle: config.handle
            }));
            if (config.heartbeat) {
                (function heartbeat(handle) {
                    db.find({handle: handle}, function (err, files) {
                        if (err) return console.error("db.find:", err);
                        spacebox.synchronize(files, function (err, updates) {
                            if (err) {
                                console.error("spacebox.synchronize:", err);
                                return socket.end();
                            }
                            console.log("Heartbeat:", Object.keys(updates).length, "updates");
                            socket.write(JSON.stringify({
                                label: "synchronized",
                                handle: handle,
                                payload: updates
                            }));
                            setTimeout(heartbeat, 60000);
                        });
                    });
                })(config.handle);
            }
        }
    });
    socket.on("error", function (err) {
        console.error(err);
        console.log("Couldn't connect to server, trying again in 15 seconds...");
        setTimeout(function () {
            connect(config);
        }, 15000);
    });
    socket.on("data", function (data) {
        console.log("received:", data.toString());
        message += data;
        try {
            var parsed = JSON.parse(message);
            message = "";
            if (parsed && parsed.label) {
                switch (parsed.label) {
                case "synchronize":
                    async.eachSeries(parsed.payload, function (file, nextFile) {
                        file.handle = parsed.handle;
                        db.update({handle: parsed.handle, id: file.id}, file, {upsert: true}, nextFile);
                    }, function (err) {
                        if (err) return console.error(err);
                        spacebox.synchronize(parsed.payload, function (err, updates) {
                            if (err) {
                                console.error(err);
                                return socket.end();
                            }
                            socket.write(JSON.stringify({
                                label: "synchronized",
                                handle: parsed.handle,
                                payload: updates
                            }));
                        });
                    });
                    break;
                case "upload":
                    spacebox.upload(parsed.path, parsed.options, function (err, files) {
                        if (err || !files) {
                            return console.error("upload failed:", err, files);
                        }
                        if (files && files.constructor === Object && !files.path) {
                            files.path = parsed.path;
                            files.filepath = parsed.path;
                            files.ipfshash = files.hash;
                            db.update({id: files.id}, files, {upsert: true}, function (err) {
                                if (err) return console.error("upload.update:", err);
                                socket.write(JSON.stringify({
                                    label: "uploaded",
                                    handle: parsed.handle,
                                    payload: files
                                }));
                            });
                        } else {
                            async.eachSeries(files, function (file, nextFile) {
                                file.handle = parsed.handle;
                                db.update({id: file.id}, file, {upsert: true}, nextFile);
                            }, function (err) {
                                if (err) return console.error(err);
                                socket.write(JSON.stringify({
                                    label: "uploaded",
                                    handle: parsed.handle,
                                    payload: files
                                }));
                            });
                        }
                    });
                    break;
                case "remove":
                    spacebox.remove(parsed.path, parsed.hash, function (err, hash) {
                        if (err) return console.error(err);
                        socket.write({
                            label: "removed",
                            id: parsed.id,
                            hash: hash,
                            path: parsed.path
                        });
                    });
                    break;
                default:
                    console.error("unknown label:", parsed.label);
                    console.log(JSON.stringify(parsed, null, 2));
                }
            }
        } catch (exc) {
            if (exc.message !== "Unexpected end of input") throw exc;
        }
    });
}

fs.exists(p.join(__dirname, "config.json"), function (exists) {    
    if (exists) return connect(require("./config"));
    var properties = [{
        name: "username",
        validator: /^[a-zA-Z\s\-]+$/,
        warning: "Username must be only letters, spaces, or dashes"
    }];
    inputprompt.start();
    inputprompt.get(properties, function (err, result) {
        if (err) return console.error(err);
        fs.writeFile(p.join(__dirname, "config.json"), JSON.stringify({
            handle: result.username,
            heartbeat: true
        }, null, 4), function (err) {
            if (err) return console.error(err);
            connect(require("./config"));
        });
    });
});
