
'use strict'

let fmt = require('logfmt')
let path = require('path')
let kue = require('kue')
let db = require('./models')
let _ = require('lodash')
let request = require('request')
let q = require('./lib/queue')
let config = require('./config')
let getValidToken = require('./lib/token')

q.process('track', track)

function pauseWorker (ctx) {
  ctx.pause(1000, function (err) {
    fmt.log({
      type: 'warning',
      msg: 'issue occured: worker paused, will resume in 30 seconds'
    })

    setTimeout(function () {
      fmt.log({
        type: 'warning',
        msg: 'worker back on duty'
      })
      ctx.resume();
    }, 30000)
  })
}

function track (job, ctx, done) {
  switch (job.data.type) {
    case 'sms':
      fmt.log({
        type: 'info',
        msg: `Worker has SMS message from ${job.data.sender}, requesting '${job.data.text}'`
      })
      processRequest(job, ctx, done)
      break;

    case 'fb':
      fmt.log({
        type: 'info',
        msg: `Worker has FB message from ${job.data.sender}, requesting '${job.data.text}'`
      })
      processRequest(job, ctx, done)
      break;

    case 'chatter':
      fmt.log({
        type: 'info',
        msg: `Worker has Chatter message from ${job.data.sender}, requesting '${job.data.text}'`
      })

    default:
      const err = new Error('Unknown message type. Skipping.')
      fmt.log({
        type: 'warning',
        msg: err
      })
      done(err)
  }
}

function processRequest(job, ctx, done) {
  db.Account.findOne({  })
  .then(function(acct) {

    if ( !acct || !acct.get('playlist_id') ) {
      let err = new Error(`No account and/or playlist found, have you auth'd with Spotify?`)
      fmt.log({ type: 'warning', msg: err })
      done(err)
      pauseWorker(ctx)
      return
    }

    db.Message.create({
      type: job.data.type,
      sender: job.data.sender,
      text: job.data.text,
      short_code: job.data.shortCode
      raw_message: job.data,
      AccountId: acct.get('id')
    })
    .then(function(msg) {

      // Search Spotify for track
      getValidToken(acct)
      .then(function(token) {

        var opts = {
          auth: { 'bearer': token },
          json: true
        }

        const query = msg.get('text')
        let spotifySearchUri = `https://api.spotify.com/v1/search?q=${query}&type=track&market=from_token&limit=1`

        request.get(spotifySearchUri, opts, function(err, res, body) {
          // Check for HTTP error
          if (err || res.statusCode ==! 200) {
            fmt.log({
              type: 'error',
              msg: err.message || res.statusCode
            })
            done(err.message || res.statusCode)
            return
          }

          // Check for at least one track returned
          let tracks = body.tracks
          if (!tracks || tracks.total === 0) {
            fmt.log({
              type: 'warning',
              msg: 'Job complete: Spotify search yielded no result',
              messageKey: msg.id,
              request: msg.body
            })
            done()
            return
          }

          let track = tracks.items[0]

          // Add track to playlist
          const user = acct.get('id')
          const playlist = acct.get('playlist_id')
          let spotifyTrackAddUri = `https://api.spotify.com/v1/users/${user}/playlists/${playlist}/tracks?uris=${track.uri}`
          request.post(spotifyTrackAddUri, opts, function(err, res, body) {
            if (err || res.statusCode ==! 200) {
              fmt.log({
                type: 'error',
                msg: err.message || res.statusCode
              })
              done(err.message || res.statusCode)
              return
            }

            fmt.log({
              type: 'info',
              msg: 'Job complete: Track added to the playlist',
              messageKey: msg.id,
              trackKey: track.uri
            })

            // Add track id to message record
            msg.update({
              track_id: track.uri
            })
            .then(function() {
              // if we got a short code from casey, queue that job now
              if ( msg.get('short_code') ) {
                const personalizedPlaylist = {
                  track: track,
                  shortCode: msg.get('short_code')
                }

                let job = q.create('personalized-playlist', personalizedPlaylist)
                const ATTEMPTS = 3

                job.attempts(ATTEMPTS).ttl(5000)

                job.on('failed attempt', function(err, doneAttempts){
                  console.log(`Worker failed to complete job, this is attempt ${doneAttempts} of ${ATTEMPTS}. Trying again.`)
                })

                job.on('failed', function(err) {
                  console.log(`Worker failed to complete job after ${ATTEMPTS} attempts,`,err)
                })

                job.save((err) => {
                  if (!err) {
                    fmt.log({
                      type: 'info',
                      msg: `Track request received, added to Redis queue`
                    })
                  }
                })
              }
              done()  // done with job
            })
            .catch(function(err) {
              throw new Error(err)
            })
          })
        })
      })
    })
  })
}
