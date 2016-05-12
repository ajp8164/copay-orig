'use strict';

angular.module('copayApp.model').factory('Wallet', function ($rootScope, $log, $timeout, $filter, lodash, isChromeApp, gettext, configService, txStatus, txFormatService, rateService, confirmDialog) {
 
  // Constructor
  // See https://medium.com/opinionated-angularjs/angular-model-objects-with-javascript-classes-2e6a067c73bc#.970bxmciz
  // 
  function Wallet(bwc) {
    this.bwc = bwc;
    this.status = null;
    return this;
  };

  // Public methods
  // 
  Wallet.prototype.get = function() {
    return this.bwc;
  };

  Wallet.prototype.isValid = function() {
    return !lodash.isUndefined(this.bwc);
  };

  Wallet.prototype.getStatus = function(cb) {
    var self = this;
    this.bwc.getStatus({
      twoStep: true
    }, function(err, ret) {
      if (err) {
        $log.debug('Could not update Wallet ' + self.getWalletId());
      }
      self.status = ret;
      return cb(err, ret);
    });
  };

  Wallet.prototype.getWalletId = function() {
    return this.bwc.credentials.walletId;
  };

  Wallet.prototype.getInfo = function() {
    return {
      config: configService.getSync().wallet,
      client: this.bwc,
      status: this.status
    };
  };

  Wallet.prototype.getBalance = function(kind) {
    if (this.status == null) {
      return null;
    }

    var config = configService.getSync().wallet;
    switch (kind) {
      case ('availableAmount'):
        var availableBalanceSat = this.status.balance.availableConfirmedAmount;
        if (config.spendUnconfirmed) {
          availableBalanceSat = this.status.balance.availableAmount;
        }
        var availableBalanceAlternative = rateService.toFiat(availableBalanceSat, config.settings.alternativeIsoCode);
        if (availableBalanceAlternative != null) {
          availableBalanceAlternative = $filter('noFractionNumber')(availableBalanceAlternative, 2);          
          return {
            native: availableBalanceSat,
            alternative: parseInt(availableBalanceAlternative)
          };
        } else {
          return null;
        }
        break;

      case ('lockedAmount'):
        var lockedBalanceSat = this.status.balance.lockedConfirmedAmount;
        if (config.spendUnconfirmed) {
          lockedBalanceSat = this.status.balance.lockedAmount;
        }
        var lockedBalanceAlternative = rateService.toFiat(lockedBalanceSat, config.settings.alternativeIsoCode);
        if (lockedBalanceAlternative != null) {
          lockedBalanceAlternative = $filter('noFractionNumber')(lockedBalanceAlternative, 2);
          return {
            native: lockedBalanceSat,
            alternative: parseInt(lockedBalanceAlternative)
          };
        } else {
          return null;
        }
        break;

      case ('totalAmount'):
        var totalBalanceSat = this.status.balance.totalConfirmedAmount;
        if (config.spendUnconfirmed) {
          totalBalanceSat = this.status.balance.totalAmount;
        }
        var totalBalanceAlternative = rateService.toFiat(totalBalanceSat, config.settings.alternativeIsoCode);
        if (totalBalanceAlternative != null) {
          totalBalanceAlternative = $filter('noFractionNumber')(totalBalanceAlternative, 2);
          return {
            native: totalBalanceSat,
            alternative: parseInt(totalBalanceAlternative)
          };
        } else {
          return null;
        }
        break;

      default:
        throw ('Error: unknown balance kind - ' + kind);
    };
  };

  Wallet.prototype.getBalanceAsString = function(kind, alternative) {
    var config = configService.getSync().wallet.settings;
    var balance = this.getBalance(kind);
    if (balance == null) {
      return '';
    } else {
      var b = (alternative ? balance.alternative : balance.native);
      var unit = (alternative ? config.alternativeIsoCode : config.unitName);
      return txFormatService.formatAmount(b) + ' ' + unit;
    }
  };

  Wallet.prototype.getFee = function(cb) {
    var bwc = this.bwc;
    var config = configService.getSync().wallet.settings;
    var feeLevel = config.feeLevel || 'normal';
    // static fee
    var fee = 10000;
    bwc.getFeeLevels(bwc.credentials.network, function(err, levels) {
      if (err) {
        return cb({message: 'Could not get dynamic fee. Using static 10000sat'}, fee);
      }
      else {
        fee = lodash.find(levels, { level: feeLevel }).feePerKB;
        $log.debug('Dynamic fee: ' + feeLevel + ' ' + fee +  ' SAT');
        return cb(null, fee); 
      }
    });
  }; 

  Wallet.prototype.getTransactionData = function(data, cb) {
    var bwc = this.bwc;
    if (data.payProUrl && isChromeApp) {
      return cb(gettext('Payment Protocol not supported on Chrome App'), null);
    }

    if (data.payProUrl) {
      $log.debug('Fetch PayPro Request from ', data.payProUrl);
      $timeout(function() {
        bwc.fetchPayPro({
          payProUrl: data.payProUrl,
        }, function(err, paypro) {

          if (err) {
            $log.warn('Could not fetch payment request:', err);
            var msg = err.toString();
            if (msg.match('HTTP')) {
              msg = gettext('Could not fetch payment information');
            }
            return cb(msg, null);
          }

          if (!paypro.verified) {
            $log.warn('Failed to verified payment protocol signatured');
            return cb(gettext('Payment Protocol Invalid'), null);
          }

          // Prepend the callers memo to the paypro memo.
          if (data.memo) {
            paypro.memo += data.memo + ' ';
          }
          return cb(null, paypro);
        });
      }, 1);

    } else {
      return cb(null, data);
    }
  };

  Wallet.prototype.lock = function() {
    try {
      bwc.lock();
    } catch (e) {};
  };

  Wallet.prototype.unlock = function(cb) {
    $log.debug('Wallet is encrypted');
    var self = this;
    var bwc = this.bwc;
    $rootScope.$emit('Local/NeedsPassword', false, function(err2, password) {
      if (err2 || !password) {
        return cb({
          message: (err2 || gettext('Password needed'))
        });
      }
      try {
        bwc.unlock(password);
      } catch (e) {
        $log.debug(e);
        return cb({
          message: gettext('Wrong password')
        });
      }
      $timeout(function() {
        if (bwc.isPrivKeyEncrypted()) {
          $log.debug('Locking wallet automatically');
          self.lock();
        };
      }, 2000);
      return cb();
    });
  };

  Wallet.prototype.requestTouchid = function(cb) {
    var bwc = this.bwc;
    var config = configService.getSync();
    config.touchIdFor = config.touchIdFor || {};
    if (window.touchidAvailable && config.touchIdFor[bwc.credentials.walletId]) {
      $rootScope.$emit('Local/RequestTouchid', cb);
    } else {
      return cb();
    }
  };

  Wallet.prototype.signAndBroadcast = function(txp, cb) {
    var self = this;
    var bwc = this.bwc;
    $rootScope.$emit('Local/FocusedWalletStatus', gettext('Signing transaction'));
    bwc.signTxProposal(txp, function(err, signedTx) {
      $rootScope.$emit('Local/FocusedWalletStatus');
      self.lock();

      if (err) {
        if (!lodash.isObject(err)) {
          err = {message: err};
        }
        err.message = bwsError.msg(err, gettextCatalog.getString('The payment was created but could not be signed. Please try again from home screen'));
        return cb(err);
      }

      if (signedTx.status == 'accepted') {
        $rootScope.$emit('Local/FocusedWalletStatus', gettext('Broadcasting transaction'));
        bwc.broadcastTxProposal(signedTx, function(err, btx, memo) {
          $rootScope.$emit('Local/FocusedWalletStatus');
          if (err) {
            err.message = bwsError.msg(err, gettextCatalog.getString('The payment was signed but could not be broadcasted. Please try again from home screen'));
            return cb(err);
          }
          if (memo) {
            $log.info(memo);
          }

          txStatus.notify($rootScope, bwc, btx, function() {
            $rootScope.$emit('Local/TxProposalAction', true);
            return cb();
          });
        });

      } else {
        txStatus.notify($rootScope, bwc, signedTx, function() {
          $rootScope.$emit('Local/TxProposalAction');
          return cb();
        });
      }
    });
  };

  //
  // data: {
  //   // For payment-protocol payments provide the following.
  //   payProUrl:
  //   memo:
  //   // For all other payments provide the following.
  //   // These values must conform to PayPro.get() properties.
  //   toAddress:
  //   amount:
  //   memo:
  // }
  // 
  Wallet.prototype.sendPayment = function(data, cb) {
    var self = this;
    var bwc = this.bwc;
    if (bwc.isPrivKeyEncrypted()) {
      Wallet.unlock(function(err) {
        if (err) {
          return cb('Could not send payment, wallet could not be unlocked');
        } else {
          return self.sendPayment(data, cb);
        }
      });
    };

    if (data.memo && !bwc.credentials.sharedEncryptingKey) {
      var msg = 'Could not add message to imported wallet without shared encrypting key';
      $log.warn(msg);
      return cb(gettext(msg));
    }

    $rootScope.$emit('Local/FocusedWalletStatus', gettext('Creating transaction'));

    var self = this;
    this.getTransactionData(data, function(err, txData) {
      self.requestTouchid(function(err) {
        if (err) {
          $rootScope.$emit('Local/FocusedWalletStatus');
          self.lock();
          return cb(err);
        }

        self.getFee(function(err, feePerKb) {
          if (err) {
            $log.debug(err);
          }

          var config = configService.getSync().wallet.settings;
          var confirmMessage = 'Send ' + (txData.amount / config.unitToSatoshi) + ' ' + config.unitName + ' to ' + txData.toAddress + '?';

          confirmDialog.show(confirmMessage, function(confirmed) {
            if (!confirmed) {
              return cb();
            }

            bwc.sendTxProposal({
              toAddress: txData.toAddress,
              amount: txData.amount,
              message: txData.memo,
              payProUrl: txData.url ? txData.url : null,
              feePerKb: feePerKb,
              excludeUnconfirmedUtxos: !configService.getSync().wallet.spendUnconfirmed
            }, function(err, txp) {
              if (err) {
                $rootScope.$emit('Local/FocusedWalletStatus');
                self.lock();
                return cb(err);
              }

              if (!bwc.canSign() && !bwc.isPrivKeyExternal()) {
                $log.info('No signing proposal: No private key')
                $rootScope.$emit('Local/FocusedWalletStatus');
                txStatus.notify($rootScope, bwc, txp, function() {
                  $rootScope.$emit('Local/TxProposalAction');
                });
                return cb();
              }

              self.signAndBroadcast(txp, function(err) {
                $rootScope.$emit('Local/FocusedWalletStatus');
                if (err) {
                  $rootScope.$emit('Local/TxProposalAction');
                  cb(err.message);
                }
              });
            });
          });
        });
      });
    });
    return cb();
  };

  return Wallet;
});
