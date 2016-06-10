'use strict';
angular.module('copayApp.services')
  .factory('profileService', function profileServiceFactory($rootScope, $timeout, $filter, $log, sjcl, lodash, storageService, bwcService, configService, notificationService, pushNotificationsService, gettext, gettextCatalog, bwsError, uxLanguage, bitcore, platformInfo, walletService) {

    var isChromeApp = platformInfo.isChromeApp;
    var isCordova = platformInfo.isCordova;
    var isWP = platformInfo.isWP;

    var root = {};
    var errors = bwcService.getErrors();
    var usePushNotifications = isCordova && !isWP;

    var FOREGROUND_UPDATE_PERIOD = 5;
    var BACKGROUND_UPDATE_PERIOD = 30;

    root.profile = null;
    root.focusedClient = null;
    root.walletClients = {};

    root.Utils = bwcService.getUtils();
    root.formatAmount = function(amount) {
      var config = configService.getSync().wallet.settings;
      if (config.unitCode == 'sat') return amount;

      //TODO : now only works for english, specify opts to change thousand separator and decimal separator
      return this.Utils.formatAmount(amount, config.unitCode);
    };

    root._setFocus = function(walletId, cb) {
      $log.debug('Set focus:', walletId);

      // Set local object
      if (walletId)
        root.focusedClient = root.walletClients[walletId];
      else
        root.focusedClient = [];

      if (lodash.isEmpty(root.focusedClient)) {
        root.focusedClient = root.walletClients[lodash.keys(root.walletClients)[0]];
      }

      // Still nothing?
      if (lodash.isEmpty(root.focusedClient)) {
        $rootScope.$emit('Local/NoWallets');
      } else {
        $rootScope.$emit('Local/NewFocusedWallet');

        // Set update period
        lodash.each(root.walletClients, function(client, id) {
          client.setNotificationsInterval(BACKGROUND_UPDATE_PERIOD);
        });
        root.focusedClient.setNotificationsInterval(FOREGROUND_UPDATE_PERIOD);
      }

      return cb();
    };

    root.setAndStoreFocus = function(walletId, cb) {
      root._setFocus(walletId, function() {
        storageService.storeFocusedWalletId(walletId, cb);
      });
    };

    // Adds a wallet client to profileService
    root.bindWalletClient = function(client, opts) {
      var opts = opts || {};
      var walletId = client.credentials.walletId;

      if ((root.walletClients[walletId] && root.walletClients[walletId].started) || opts.force) {
        return false;
      }

      root.walletClients[walletId] = client;
      root.walletClients[walletId].started = true;
      root.walletClients[walletId].doNotVerifyPayPro = isChromeApp;

      if (client.incorrectDerivation) {
        $log.warn('Key Derivation failed for wallet:' + walletId);
        storageService.clearLastAddress(walletId, function() {});
      }

      client.removeAllListeners();
      client.on('report', function(n) {
        $log.info('BWC Report:' + n);
      });

      client.on('notification', function(n) {
        $log.debug('BWC Notification:', n);
        notificationService.newBWCNotification(n,
          walletId, client.credentials.walletName);

        if (root.focusedClient.credentials.walletId == walletId) {
          $rootScope.$emit(n.type, n);
        } else {
          $rootScope.$apply();
        }
      });

      client.on('walletCompleted', function() {
        $log.debug('Wallet completed');

        root.updateCredentials(client.export(), function() {
          $rootScope.$emit('Local/WalletCompleted', walletId);
        });
      });

      if (client.hasPrivKeyEncrypted() && !client.isPrivKeyEncrypted()) {
        $log.warn('Auto locking unlocked wallet:' + walletId);
        client.lock();
      }

      client.initialize({}, function(err) {
        if (err) {
          $log.error('Could not init notifications err:', err);
          return;
        }
        client.setNotificationsInterval(BACKGROUND_UPDATE_PERIOD);
      });

      return true;
    };


    // Used when reading wallets from the profile
    root.bindWallet = function(credentials) {
      if (!credentials.walletId)
        throw 'bindWallet should receive credentials JSON';

      $log.debug('Bind wallet:' + credentials.walletId);

      // Create the client
      var getBWSURL = function(walletId) {
        var config = configService.getSync();
        var defaults = configService.getDefaults();
        return ((config.bwsFor && config.bwsFor[walletId]) || defaults.bws.url);
      };

      var skipKeyValidation = root.profile.isChecked(platformInfo.ua, credentials.walletId);
      var client = bwcService.getClient(JSON.stringify(credentials), {
        bwsurl: getBWSURL(credentials.walletId),
        skipKeyValidation: skipKeyValidation,
      });

      if (!skipKeyValidation && !client.incorrectDerivation)
        root.profile.setChecked(platformInfo.ua, credentials.walletId);

      return root.bindWalletClient(client);
    };

    root.bindProfile = function(profile, cb) {
      root.profile = profile;

      configService.get(function(err) {
        $log.debug('Preferences read');
        if (err) return cb(err);

        lodash.each(root.profile.credentials, function(credentials) {
          root.bindWallet(credentials);
        });
        $rootScope.$emit('Local/WalletListUpdated');

        storageService.getFocusedWalletId(function(err, focusedWalletId) {
          if (err) return cb(err);
          root._setFocus(focusedWalletId, function() {
            if (usePushNotifications)
              root.pushNotificationsInit();
            root.isDisclaimerAccepted(function(val) {
              if (!val) {
                return cb(new Error('NONAGREEDDISCLAIMER: Non agreed disclaimer'));
              }
              return cb();
            });
          });
        });
      });
    };

    root.pushNotificationsInit = function() {
      var defaults = configService.getDefaults();
      var push = pushNotificationsService.init(root.walletClients);

      push.on('notification', function(data) {
        if (!data.additionalData.foreground) {
          window.ignoreMobilePause = true;
          $log.debug('Push notification event: ', data.message);

          $timeout(function() {
            var wallets = root.getWallets();
            var walletToFind = data.additionalData.walletId;

            var walletFound = lodash.find(wallets, function(w) {
              return (lodash.isEqual(walletToFind, sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(w.id))));
            });

            if (!walletFound) return $log.debug('Wallet not found');
            root.setAndStoreFocus(walletFound.id, function() {});
          }, 100);
        }

        // Handle a point-of-sale payment notification.
        if (data.additionalData.posPayment) {
          $rootScope.$emit('Local/PosPaymentNotification', data);
        }
      });
    };


    root.getProfile = function(cb) {
      storageService.getProfile(function(err, profile) {
        return cb(err, profile);
      });
    };

    root.loadAndBindProfile = function(cb) {
      storageService.getProfile(function(err, profile) {
        if (err) {
          $rootScope.$emit('Local/DeviceError', err);
          return cb(err);
        }
        if (!profile) {
          // Migration??
          storageService.tryToMigrate(function(err, migratedProfile) {
            if (err) return cb(err);
            if (!migratedProfile)
              return cb(new Error('NOPROFILE: No profile'));

            profile = migratedProfile;
            return root.bindProfile(profile, cb);
          })
        } else {
          $log.debug('Profile read');
          return root.bindProfile(profile, cb);
        }
      });
    };

    var seedWallet = function(opts, cb) {
      opts = opts || {};
      var walletClient = bwcService.getClient(null, opts);
      var network = opts.networkName || 'livenet';

      if (opts.mnemonic) {
        try {
          opts.mnemonic = root._normalizeMnemonic(opts.mnemonic);
          walletClient.seedFromMnemonic(opts.mnemonic, {
            network: network,
            passphrase: opts.passphrase,
            account: opts.account || 0,
            derivationStrategy: opts.derivationStrategy || 'BIP44',
          });

        } catch (ex) {
          $log.info(ex);
          return cb(gettext('Could not create: Invalid wallet recovery phrase'));
        }
      } else if (opts.extendedPrivateKey) {
        try {
          walletClient.seedFromExtendedPrivateKey(opts.extendedPrivateKey);
        } catch (ex) {
          $log.warn(ex);
          return cb(gettext('Could not create using the specified extended private key'));
        }
      } else if (opts.extendedPublicKey) {
        try {
          walletClient.seedFromExtendedPublicKey(opts.extendedPublicKey, opts.externalSource, opts.entropySource, {
            account: opts.account || 0,
            derivationStrategy: opts.derivationStrategy || 'BIP44',
          });
        } catch (ex) {
          $log.warn("Creating wallet from Extended Public Key Arg:", ex, opts);
          return cb(gettext('Could not create using the specified extended public key'));
        }
      } else {
        var lang = uxLanguage.getCurrentLanguage();
        try {
          walletClient.seedFromRandomWithMnemonic({
            network: network,
            passphrase: opts.passphrase,
            language: lang,
            account: 0,
          });
        } catch (e) {
          $log.info('Error creating recovery phrase: ' + e.message);
          if (e.message.indexOf('language') > 0) {
            $log.info('Using default language for recovery phrase');
            walletClient.seedFromRandomWithMnemonic({
              network: network,
              passphrase: opts.passphrase,
              account: 0,
            });
          } else {
            return cb(e);
          }
        }
      }
      return cb(null, walletClient);
    };

    // Creates a wallet on BWC/BWS
    var doCreateWallet = function(opts, cb) {
      $log.debug('Creating Wallet:', opts);
      seedWallet(opts, function(err, walletClient) {
        if (err) return cb(err);

        var name = opts.name || gettextCatalog.getString('Personal Wallet');
        var myName = opts.myName || gettextCatalog.getString('me');

console.log('[profileService.js.303]', opts); //TODO
        walletClient.createWallet(name, myName, opts.m, opts.n, {
          network: opts.networkName,
          singleAddress: opts.singleAddress,
          walletPrivKey: opts.walletPrivKey,
        }, function(err, secret) {
          if (err) return bwsError.cb(err, gettext('Error creating wallet'), cb);
          return cb(null, walletClient, secret);
        });
      });
    };

    // Creates the default Copay profile and its wallet
    root.createDefaultProfile = function(opts, cb) {
      var p = Profile.create();

      if (opts.noWallet) {
        return cb(null, p);
      }

      opts.m = 1;
      opts.n = 1;
      opts.network = 'livenet';

      doCreateWallet(opts, function(err, walletClient) {
        if (err) return cb(err);

        p.addWallet(JSON.parse(walletClient.export()));
        return cb(null, p);
      });
    };

    // create and store a wallet
    root.createWallet = function(opts, cb) {
      doCreateWallet(opts, function(err, walletClient, secret) {
        if (err) return cb(err);

        root.addAndBindWalletClient(walletClient, {
          bwsurl: opts.bwsurl
        }, cb);
      });
    };

    // joins and stores a wallet
    root.joinWallet = function(opts, cb) {
      var walletClient = bwcService.getClient();
      $log.debug('Joining Wallet:', opts);

      try {
        var walletData = bwcService.parseSecret(opts.secret);

        // check if exist
        if (lodash.find(root.profile.credentials, {
            'walletId': walletData.walletId
          })) {
          return cb(gettext('Cannot join the same wallet more that once'));
        }
      } catch (ex) {
        $log.debug(ex);
        return cb(gettext('Bad wallet invitation'));
      }
      opts.networkName = walletData.network;
      $log.debug('Joining Wallet:', opts);

      seedWallet(opts, function(err, walletClient) {
        if (err) return cb(err);

        walletClient.joinWallet(opts.secret, opts.myName || 'me', {}, function(err) {
          if (err) return bwsError.cb(err, gettext('Could not join wallet'), cb);
          root.addAndBindWalletClient(walletClient, {
            bwsurl: opts.bwsurl
          }, cb);
        });
      });
    };

    root.getClient = function(walletId) {
      return root.walletClients[walletId];
    };

    root.deleteWalletClient = function(client, cb) {
      var walletId = client.credentials.walletId;

      pushNotificationsService.unsubscribe(root.getClient(walletId), function(err) {
        if (err) $log.warn('Unsubscription error: ' + err.message);
        else $log.debug('Unsubscribed from push notifications service');
      });

      $log.debug('Deleting Wallet:', client.credentials.walletName);
      client.removeAllListeners();

      root.profile.deleteWallet(walletId);

      delete root.walletClients[walletId];
      root.focusedClient = null;


      storageService.removeAllWalletData(walletId, function(err) {
        if (err) $log.warn(err);
      });


      $timeout(function() {
        $rootScope.$emit('Local/WalletListUpdated');

        root.setAndStoreFocus(null, function() {
          storageService.storeProfile(root.profile, function(err) {
            if (err) return cb(err);
            return cb();
          });
        });
      });
    };

    root.setMetaData = function(walletClient, addressBook, historyCache, cb) {
      storageService.getAddressbook(walletClient.credentials.network, function(err, localAddressBook) {
        var localAddressBook1 = {};
        try {
          localAddressBook1 = JSON.parse(localAddressBook);
        } catch (ex) {
          $log.warn(ex);
        }
        var mergeAddressBook = lodash.merge(addressBook, localAddressBook1);
        storageService.setAddressbook(walletClient.credentials.network, JSON.stringify(addressBook), function(err) {
          if (err) return cb(err);
          storageService.setTxHistory(JSON.stringify(historyCache), walletClient.credentials.walletId, function(err) {
            if (err) return cb(err);
            return cb(null);
          });
        });
      });
    }

    // Adds and bind a new client to the profile
    root.addAndBindWalletClient = function(client, opts, cb) {
      if (!client || !client.credentials)
        return cb(gettext('Could not access wallet'));

      var walletId = client.credentials.walletId

      if (!root.profile.addWallet(JSON.parse(client.export())))
        return cb(gettext('Wallet already in Copay'));

      root.bindWalletClient(client);
      $rootScope.$emit('Local/WalletListUpdated', client);

      var saveBwsUrl = function(cb) {
        var defaults = configService.getDefaults();
        var bwsFor = {};
        bwsFor[walletId] = opts.bwsurl || defaults.bws.url;

        // Dont save the default
        if (bwsFor[walletId] == defaults.bws.url)
          return cb();

        configService.set({
          bwsFor: bwsFor,
        }, function(err) {
          if (err) $log.warn(err);
          return cb();
        });
      };

      var handleImportedClient = function(cb) {
        if (!opts.isImport) return cb();
        $rootScope.$emit('Local/BackupDone', walletId);

        if (!client.isComplete())
          return cb();

        storageService.setCleanAndScanAddresses(walletId, cb);
      };

      walletService.updateRemotePreferences(client, {}, function() {
        $log.debug('Remote preferences saved for:' + walletId)
      });

      saveBwsUrl(function() {
        handleImportedClient(function() {
          root.setAndStoreFocus(walletId, function() {
            storageService.storeProfile(root.profile, function(err) {

              var config = configService.getSync();
              if (config.pushNotifications.enabled)
                pushNotificationsService.enableNotifications(root.walletClients);
              return cb(err, walletId);
            });

          });
        });
      });
    };

    root.storeProfileIfDirty = function(cb) {
      if (root.profile.dirty) {
        storageService.storeProfile(root.profile, function(err) {
          $log.debug('Saved modified Profile');
          if (cb) return cb(err);
        });
      } else {
        if (cb) return cb();
      };
    };

    root.importWallet = function(str, opts, cb) {

      var walletClient = bwcService.getClient(null, opts);

      $log.debug('Importing Wallet:', opts);
      try {
        walletClient.import(str, {
          compressed: opts.compressed,
          password: opts.password
        });
      } catch (err) {
        return cb(gettext('Could not import. Check input file and spending password'));
      }

      str = JSON.parse(str);

      var addressBook = str.addressBook || {};
      var historyCache = str.historyCache ||  [];

      if (!walletClient.incorrectDerivation)
        root.profile.setChecked(platformInfo.ua, walletClient.credentials.walletId);

      root.addAndBindWalletClient(walletClient, {
        bwsurl: opts.bwsurl,
        isImport: true
      }, function(err, walletId) {
        if (err) return cb(err);
        root.setMetaData(walletClient, addressBook, historyCache, function(error) {
          if (error) $log.warn(error);
          return cb(err, walletId);
        });
      });
    };

    root.importExtendedPrivateKey = function(xPrivKey, opts, cb) {
      var walletClient = bwcService.getClient(null, opts);
      $log.debug('Importing Wallet xPrivKey');

      walletClient.importFromExtendedPrivateKey(xPrivKey, opts, function(err) {
        if (err) {
          if (err instanceof errors.NOT_AUTHORIZED)
            return cb(err);

          return bwsError.cb(err, gettext('Could not import'), cb);
        }

        root.addAndBindWalletClient(walletClient, {
          bwsurl: opts.bwsurl,
          isImport: true
        }, cb);
      });
    };

    root._normalizeMnemonic = function(words) {
      var isJA = words.indexOf('\u3000') > -1;
      var wordList = words.split(/[\u3000\s]+/);

      return wordList.join(isJA ? '\u3000' : ' ');
    };

    root.importMnemonic = function(words, opts, cb) {
      var walletClient = bwcService.getClient(null, opts);

      $log.debug('Importing Wallet Mnemonic');

      words = root._normalizeMnemonic(words);
      walletClient.importFromMnemonic(words, {
        network: opts.networkName,
        passphrase: opts.passphrase,
        account: opts.account || 0,
      }, function(err) {
        if (err) {
          if (err instanceof errors.NOT_AUTHORIZED)
            return cb(err);

          return bwsError.cb(err, gettext('Could not import'), cb);
        }

        root.addAndBindWalletClient(walletClient, {
          bwsurl: opts.bwsurl,
          isImport: true
        }, cb);
      });
    };

    root.importExtendedPublicKey = function(opts, cb) {
      var walletClient = bwcService.getClient(null, opts);
      $log.debug('Importing Wallet XPubKey');

      walletClient.importFromExtendedPublicKey(opts.extendedPublicKey, opts.externalSource, opts.entropySource, {
        account: opts.account || 0,
        derivationStrategy: opts.derivationStrategy || 'BIP44',
      }, function(err) {
        if (err) {

          // in HW wallets, req key is always the same. They can't addAccess.
          if (err instanceof errors.NOT_AUTHORIZED)
            err.name = 'WALLET_DOES_NOT_EXIST';

          return bwsError.cb(err, gettext('Could not import'), cb);
        }

        root.addAndBindWalletClient(walletClient, {
          bwsurl: opts.bwsurl,
          isImport: true
        }, cb);
      });
    };

    root.create = function(opts, cb) {
      $log.info('Creating profile', opts);
      var defaults = configService.getDefaults();

      configService.get(function(err) {

        root.createDefaultProfile(opts, function(err, p) {
          if (err) return cb(err);

          root.bindProfile(p, function(err) {
            // ignore NONAGREEDDISCLAIMER
            storageService.storeNewProfile(p, function(err) {
              return cb(err);
            });
          });
        });
      });
    };

    root.setDisclaimerAccepted = function(cb) {
      root.profile.disclaimerAccepted = true;
      storageService.storeProfileThrottled(root.profile, function(err) {
        return cb(err);
      });
    };

    root.isDisclaimerAccepted = function(cb) {
      var disclaimerAccepted = root.profile && root.profile.disclaimerAccepted;
      if (disclaimerAccepted)
        return cb(true);

      // OLD flag
      storageService.getCopayDisclaimerFlag(function(err, val) {
        if (val) {
          root.profile.disclaimerAccepted = true;
          return cb(true);
        } else {
          return cb();
        }
      });
    };

    root.importLegacyWallet = function(username, password, blob, cb) {
      var walletClient = bwcService.getClient();

      walletClient.createWalletFromOldCopay(username, password, blob, function(err, existed) {
        if (err) return cb(gettext('Error importing wallet: ') + err);

        if (root.profile.hasWallet(walletClient.credentials.walletId)) {
          $log.debug('Wallet:' + walletClient.credentials.walletName + ' already imported');
          return cb(gettext('Wallet Already Imported: ') + walletClient.credentials.walletName);
        };

        root.addAndBindWalletClient(walletClient, {
          isImport: true
        }, cb);
      });
    };

    root.updateCredentials = function(credentials, cb) {
      root.profile.updateWallet(credentials);
      storageService.storeProfileThrottled(root.profile, cb);
    };

    root.getClients = function() {
      return lodash.values(root.walletClients);
    };

    root.needsBackup = function(client, cb) {

      if (!walletService.needsBackup(client))
        return cb(false);

      storageService.getBackupFlag(client.credentials.walletId, function(err, val) {
        if (err) $log.error(err);
        if (val) return cb(false);
        return cb(true);
      });
    };

    root.isReady = function(client, cb) {
      if (!client.isComplete())
        return cb('WALLET_NOT_COMPLETE');

      root.needsBackup(client, function(needsBackup) {
        if (needsBackup)
          return cb('WALLET_NEEDS_BACKUP');
        return cb();
      });
    };

    root.getWallets = function(network) {
      if (!root.profile) return [];

      var config = configService.getSync();
      config.colorFor = config.colorFor || {};
      config.aliasFor = config.aliasFor || {};
      var ret = lodash.map(root.profile.credentials, function(c) {
        return {
          m: c.m,
          n: c.n,
          name: config.aliasFor[c.walletId] || c.walletName,
          id: c.walletId,
          network: c.network,
          color: config.colorFor[c.walletId] || '#4A90E2',
          copayerId: c.copayerId
        };
      });
      if (network) {
        ret = lodash.filter(ret, function(w) {
          return (w.network == network);
        });
      }
      return lodash.sortBy(ret, 'name');
    };

    return root;
  });
