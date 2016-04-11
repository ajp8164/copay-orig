'use strict';

angular.module('copayApp.controllers').controller('preferencesGlobalController',
  function($scope, $rootScope, $log, configService, uxLanguage, isCordova, isMobile, pushNotificationsService, profileService, feeService) {

    this.init = function() {
      var config = configService.getSync();
      this.unitName = config.wallet.settings.unitName;
      this.currentLanguageName = uxLanguage.getCurrentLanguageName();
      this.selectedAlternative = {
        name: config.wallet.settings.alternativeName,
        isoCode: config.wallet.settings.alternativeIsoCode
      };
      this.feeOpts = feeService.feeOpts;
      this.currentFeeLevel = feeService.getCurrentFeeLevel();
      this.usePushNotifications = isCordova && !isMobile.Windows();
      $scope.spendUnconfirmed = config.wallet.spendUnconfirmed;
      $scope.glideraVisible = config.glidera.visible;
      $scope.glideraTestnet = config.glidera.testnet;
      $scope.pushNotifications = config.pushNotifications.enabled;
    };

    var unwatchSpendUnconfirmed = $scope.$watch('spendUnconfirmed', function(newVal, oldVal) {
      if (newVal == oldVal) return;
      var opts = {
        wallet: {
          spendUnconfirmed: newVal
        }
      };
      configService.set(opts, function(err) {
        $rootScope.$emit('Local/SpendUnconfirmedUpdated', newVal);
        if (err) $log.debug(err);
      });
    });

    var unwatchPushNotifications = $scope.$watch('pushNotifications', function(newVal, oldVal) {
      if (newVal == oldVal) return;
      var opts = {
        pushNotifications: {
          enabled: newVal
        }
      };
      configService.set(opts, function(err) {
        if (opts.pushNotifications.enabled)
          pushNotificationsService.enableNotifications(profileService.walletClients);
        else
          pushNotificationsService.disableNotifications(profileService.walletClients);
        if (err) $log.debug(err);
      });
    });

    var unwatchGlideraVisible = $scope.$watch('glideraVisible', function(newVal, oldVal) {
      if (newVal == oldVal) return;
      var opts = {
        glidera: {
          visible: newVal
        }
      };
      configService.set(opts, function(err) {
        $rootScope.$emit('Local/GlideraUpdated');
        if (err) $log.debug(err);
      });
    });

    var unwatchGlideraTestnet = $scope.$watch('glideraTestnet', function(newVal, oldVal) {
      if (newVal == oldVal) return;
      var opts = {
        glidera: {
          testnet: newVal
        }
      };
      configService.set(opts, function(err) {
        $rootScope.$emit('Local/GlideraUpdated');
        if (err) $log.debug(err);
      });
    });

    $scope.$on('$destroy', function() {
      unwatchSpendUnconfirmed();
      unwatchGlideraVisible();
      unwatchGlideraTestnet();
      unwatchPushNotifications();
    });
  });
