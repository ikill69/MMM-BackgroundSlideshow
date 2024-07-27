/*
 * node_helper.js
 *
 * MagicMirror²
 * Module: MMM-BackgroundSlideshow
 *
 * MagicMirror² By Michael Teeuw https://michaelteeuw.nl
 * MIT Licensed.
 *
 * Module MMM-BackgroundSlideshow By Darick Carpenter
 * MIT Licensed.
 */

// call in the required classes
const NodeHelper = require('node_helper');
const FileSystemImageSlideshow = require('fs');
const Jimp = require('jimp');
const jo = require('jpeg-autorotate');
const {exec} = require('child_process');
const express = require('express');
const Log = require('../../js/logger.js');
const basePath = '/images/';
const axios = require('axios');

// the main module helper create
module.exports = NodeHelper.create({

  // subclass start method, clears the initial config array
  start () {
    this.excludePaths = new Set();
    this.validImageFileExtensions = new Set();
    this.expressInstance = this.expressApp;
    this.imageList = [];
    this.index = 0;
    this.timer = null;
    self = this;
  },

  // This is the original shit shuffle that never works as it is pseudo random but ok for backup
  shitShuffle (array) {
    for (let i = array.length - 1; i > 0; i--) {
      // j is a random index in [0, i].
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  },
  
  // shuffles an array at random and returns it
  // making this async is not ideal as it does mean that it starts trying to show all 50K photos 
  // but then quickly switches over to just the random 1000 per day 1 per minute that I have setup
  // TODO: Clean this up later 
  async shuffleArray (array, randomOrgApiKey) {

      Log.info(`BACKGROUNDSLIDESHOW: Total Image Count ${array.length}`);

      // Start by performing a shit shuffle in case of any error this will be better than nothing as a default shuffle
      arrary = this.shitShuffle(array);

      try {
            
            if(!randomOrgApiKey){
              Log.error(`BACKGROUNDSLIDESHOW: randomOrgApiKey missing or not set in config`);
              return array;
            }

            // Setup For calling Randon.Org
            // https://api.random.org/json-rpc/4/basic
            const key = randomOrgApiKey;
            const apiUrl = 'https://api.random.org/json-rpc/4/invoke';
            const requestBody = {
                "jsonrpc": "2.0",
                "method": "generateIntegers",
                "params": {
                    "apiKey": key,
                    "n": 1333, // Default 1333 pictures per day. 1000 = 1/minute for 17 hours perfect for my use case and config...  
                    "min": 0,
                    "max": 1000, // Default set this later based on count
                    "replacement": false // Only unique results avoid duplicate values 
                },
                "id": 42
            };

            // This JavaScript function always returns a random number between min and max (both included):
            const min = 1100;
            const max = 1333;
            const rand = Math.floor(Math.random() * (max - min + 1) ) + min;
            
            // Avoid any kind of patten or pseudo random make it fect a diferent number of random images each day
            requestBody.params.n = rand;
            requestBody.params.max = array.length-1;    

            // Setup for calling the service
            const randomIndicesSet = await axios.post(apiUrl, requestBody)
                  .then(response => {
                      //console.log('Response from API:', response.data);
                      // Really this only happens once per day in the morning when the Digital Photo Frame comes on 
                      // So I don't care about lokking out the full response 
                      Log.debug(`BACKGROUNDSLIDESHOW: Randon.Org response=${ JSON.stringify(response.data)}`);
                      
                      const randomSet = response.data.result.random.data;

                      Log.info(`BACKGROUNDSLIDESHOW: Randon.Org randomIndicesSet.length=${randomSet.length}`);

                      return randomSet;
                  }).catch(error => {
                    Log.info(`Filter array error=${error}`);
                  });

            // Filter the array, keeping only the items whose index are in the random set
            let arrayFilter = array.filter((item, index) => randomIndicesSet.includes(index));
                                                        
            Log.info(`BACKGROUNDSLIDESHOW: Filtered length=${arrayFilter.length}`);

            // Now use the old shit Shuffle again in the properly random filtered list. 
            // Random.Org has taken care of the real Random selection of images for the day
            arrayFilter = this.shitShuffle(arrayFilter);

            // Over write the array with random subset 
            array=arrayFilter;

        } catch (error) {
            Log.info(`trycatch error=${error}`);
        } 
 
    Log.info(`BACKGROUNDSLIDESHOW: Random Shuffle Image Count ${array.length}`);

    return array;
  },

  // sort by filename attribute
  sortByFilename (a, b) {
    const aL = a.path.toLowerCase();
    const bL = b.path.toLowerCase();
    if (aL > bL) return 1;
    return -1;
  },

  // sort by created attribute
  sortByCreated (a, b) {
    const aL = a.created;
    const bL = b.created;
    if (aL > bL) return 1;
    return -1;
  },

  // sort by created attribute
  sortByModified (a, b) {
    const aL = a.modified;
    const bL = b.modified;
    if (aL > bL) return 1;
    return -1;
  },

  sortImageList (imageList, sortBy, sortDescending) {
    let sortedList = imageList;
    switch (sortBy) {
      case 'created':
        // Log.log('Sorting by created date...');
        sortedList = imageList.sort(this.sortByCreated);
        break;
      case 'modified':
        // Log.log('Sorting by modified date...');
        sortedList = imageList.sort(this.sortByModified);
        break;
      default:
        // sort by name
        // Log.log('Sorting by name...');
        sortedList = imageList.sort(this.sortByFilename);
    }

    // If the user chose to sort in descending order then reverse the array
    if (sortDescending === true) {
      // Log.log('Reversing sort order...');
      sortedList = sortedList.reverse();
    }

    return sortedList;
  },

  // checks there's a valid image file extension
  checkValidImageFileExtension (filename) {
    if (!filename.includes('.')) {
      // No file extension.
      return false;
    }
    const fileExtension = filename.split('.').pop()
      .toLowerCase();
    return this.validImageFileExtensions.has(fileExtension);
  },

  // gathers the image list
  async gatherImageList (config, sendNotification) {
    // Invalid config. retrieve it again
    if (typeof config === 'undefined' || !Object.hasOwn(Object(config), 'imagePaths') || !Object.hasOwn(Object(config), 'randomOrgApiKey')) {
      this.sendSocketNotification('BACKGROUNDSLIDESHOW_REGISTER_CONFIG');
      return;
    }

    // create an empty main image list
    this.imageList = [];
    for (let i = 0; i < config.imagePaths.length; i++) {
      this.getFiles(config.imagePaths[i], this.imageList, config);
    }

    this.imageList = config.randomizeImageOrder
      ? await this.shuffleArray(this.imageList, config.randomOrgApiKey)
      : this.sortImageList(
        this.imageList,
        config.sortImagesBy,
        config.sortImagesDescending
      );
    Log.info(`BACKGROUNDSLIDESHOW: ${this.imageList.length} files found`);
    this.index = 0;

    // let other modules know about slideshow images
    this.sendSocketNotification('BACKGROUNDSLIDESHOW_FILELIST', {
      imageList: this.imageList
    });

    // build the return payload
    const returnPayload = {
      identifier: config.identifier
    };

    // signal ready
    if (sendNotification) {
      this.sendSocketNotification('BACKGROUNDSLIDESHOW_READY', returnPayload);
    }
  },

  getNextImage () {
    if (!this.imageList.length || this.index >= this.imageList.length) {
      // if there are no images or all the images have been displayed, try loading the images again
      this.gatherImageList(this.config);
    }
    //
    if (!this.imageList.length) {
      // still no images, search again after 10 mins
      setTimeout(() => {
        this.getNextImage(this.config);
      }, 600000);
      return;
    }

    const image = this.imageList[this.index++];
    Log.info(`BACKGROUNDSLIDESHOW: reading path "${image.path}"`);
    self = this;
    this.readFile(image.path, (data) => {
      const returnPayload = {
        identifier: self.config.identifier,
        path: image.path,
        data,
        index: self.index,
        total: self.imageList.length
      };
      self.sendSocketNotification(
        'BACKGROUNDSLIDESHOW_DISPLAY_IMAGE',
        returnPayload
      );
    });

    // (re)set the update timer
    this.startOrRestartTimer();
  },

  // stop timer if it's running
  stopTimer: function () {
    if (this.timer) {
      Log.debug('BACKGROUNDSLIDESHOW: stopping update timer');
      var it = this.timer;
      this.timer = null;
      clearTimeout(it);
    }
  },
  // resume timer if it's not running; reset if it is
  startOrRestartTimer: function () {
    this.stopTimer();
    Log.debug('BACKGROUNDSLIDESHOW: restarting update timer');
    this.timer = setTimeout(function () {
      self.getNextImage();
    }, self.config?.slideshowSpeed || 10000);
  },

  getPrevImage () {
    // imageIndex is incremented after displaying an image so -2 is needed to
    // get to previous image index.
    this.index -= 2;

    // Case of first image, go to end of array.
    if (this.index < 0) {
      this.index = 0;
    }
    this.getNextImage();
  },

  resizeImage (input, callback) {
    Jimp.read(input)
      .then((image) => {
        image
          .scaleToFit(
            parseInt(this.config.maxWidth, 10),
            parseInt(this.config.maxHeight, 10)
          )
          .getBuffer(Jimp.MIME_JPEG, (err, buffer) => {
            callback(`data:image/jpg;base64, ${buffer.toString('base64')}`);
          });
      })
      .catch((err) => {
        Log.log(err);
      });
  },

  readFile (filepath, callback) {
    if (this.config.resizeImages) {
      const ext = filepath.split('.').pop();
      if (ext === 'jpg' || ext === 'jpeg') {
        jo.rotate(
          filepath,
          {quality: 30},
          (error, buffer, orientation, dimensions, quality) => {
            if (error) {
              // Log.log(
              //   'An error occurred when rotating the file: ' + error.message
              // );
              this.resizeImage(filepath, callback);
            } else {
              this.resizeImage(buffer, callback);
            }
          }
        );
      } else {
        this.resizeImage(filepath, callback);
      }
    } else {
      const ext = filepath.split('.').pop();
      const data = FileSystemImageSlideshow.readFileSync(filepath, {
        encoding: 'base64'
      });
      callback(`data:image/${ext};base64, ${data}`);
    }
  },

  getFiles (path, imageList, config) {
    Log.info(`BACKGROUNDSLIDESHOW: Reading directory "${path}" for images.`);
    const contents = FileSystemImageSlideshow.readdirSync(path);
    for (let i = 0; i < contents.length; i++) {
      if (this.excludePaths.has(contents[i])) {
        continue;
      }
      const currentItem = `${path}/${contents[i]}`;
      const stats = FileSystemImageSlideshow.lstatSync(currentItem);
      if (stats.isDirectory() && config.recursiveSubDirectories) {
        this.getFiles(currentItem, imageList, config);
      } else if (stats.isFile()) {
        const isValidImageFileExtension =
          this.checkValidImageFileExtension(currentItem);
        if (isValidImageFileExtension) {
          imageList.push({
            path: currentItem,
            created: stats.ctimeMs,
            modified: stats.mtimeMs
          });
        }
      }
    }
  },

  // subclass socketNotificationReceived, received notification from module
  socketNotificationReceived (notification, payload) {
    if (notification === 'BACKGROUNDSLIDESHOW_REGISTER_CONFIG') {
      const config = payload;
      this.expressInstance.use(
        basePath + config.imagePaths[0],
        express.static(config.imagePaths[0], {maxAge: 3600000})
      );

      // Create set of excluded subdirectories.
      this.excludePaths = new Set(config.excludePaths);

      // Create set of valid image extensions.
      const validExtensionsList = config.validImageFileExtensions
        .toLowerCase()
        .split(',');
      this.validImageFileExtensions = new Set(validExtensionsList);

      // Get the image list in a non-blocking way since large # of images would cause
      // the MagicMirror startup banner to get stuck sometimes.
      this.config = config;
      setTimeout(() => {
        this.gatherImageList(config, true);
        this.getNextImage();
      }, 200);
    } else if (notification === 'BACKGROUNDSLIDESHOW_PLAY_VIDEO') {
      Log.info('mw got BACKGROUNDSLIDESHOW_PLAY_VIDEO');
      Log.info(`cmd line: omxplayer --win 0,0,1920,1080 --alpha 180 ${payload[0]}`);
      exec(
        `omxplayer --win 0,0,1920,1080 --alpha 180 ${payload[0]}`,
        (e, stdout, stderr) => {
          this.sendSocketNotification('BACKGROUNDSLIDESHOW_PLAY', null);
          Log.info('mw video done');
        }
      );
    } else if (notification === 'BACKGROUNDSLIDESHOW_NEXT_IMAGE') {
      Log.info('BACKGROUNDSLIDESHOW_NEXT_IMAGE');
      this.getNextImage();
    } else if (notification === 'BACKGROUNDSLIDESHOW_PREV_IMAGE') {
      Log.info('BACKGROUNDSLIDESHOW_PREV_IMAGE');
      this.getPrevImage();
    } else if (notification === 'BACKGROUNDSLIDESHOW_PAUSE') {
      this.stopTimer();
    } else if (notification === 'BACKGROUNDSLIDESHOW_PLAY') {
      this.startOrRestartTimer();
    }
  }
});
