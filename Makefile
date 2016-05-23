VERSION=1.11.0

sign:
	gpg -u 1112CFA1 --output browser-extensions/chrome/cosmos-chrome-extension.zip.sig --detach-sig browser-extensions/chrome/cosmos-chrome-extension.zip
verify: 
	gpg --verify browser-extensions/chrome/cosmos-chrome-extension.zip.sig browser-extensions/chrome/cosmos-chrome-extension.zip

sign-osx:
	codesign -s 3rd webkitbuilds/cosmos-osx.dmg 

verify-osx:
	codesign -dv webkitbuilds/cosmos-osx.dmg 

sign-desktop:
	gpg -u 1112CFA1 --output webkitbuilds/cosmos-linux.zip.sig --detach-sig webkitbuilds/cosmos-linux.zip
	gpg -u 1112CFA1 --output webkitbuilds/cosmos-win.exe.sig --detach-sig webkitbuilds/cosmos-win.exe

verify-desktop:
	gpg --verify webkitbuilds/cosmos-linux.zip.sig webkitbuilds/cosmos-linux.zip
	gpg --verify webkitbuilds/cosmos-win.exe.sig webkitbuilds/cosmos-win.exe

chrome:
	browser-extensions/chrome/build.sh

cordova-base:
	grunt --target=cosmos dist-mobile

# ios:  cordova-base
# 	make -C cordova ios
# 	open cordova/project/platforms/ios/Cosmos
#
# android: cordova-base
# 	make -C cordova run-android
#
# release-android: cordova-base
# 	make -C cordova release-android
#
wp8-prod:
	cordova/build.sh WP8 cosmos --clear
	cordova/wp/fix-svg.sh
	echo -e "\a"

wp8-debug:
	cordova/build.sh WP8 cosmos --dbgjs
	cordova/wp/fix-svg.sh
	echo -e "\a"

ios-prod:
	cordova/build.sh IOS cosmos --clear
	cd cordova/project && cordova build ios
	open "cordova/project/platforms/ios/Cosmos.xcodeproj"

ios-debug:
	cordova/build.sh IOS cosmos --dbgjs
	cd cordova/project && cordova build ios
	open "cordova/project/platforms/ios/Cosmos.xcodeproj"

android-prod:
	cordova/build.sh ANDROID cosmos --clear
	rm -f cordova/project/platforms/android/build/outputs/apk/android-release-signed-aligned.apk 
	cd cordova/project && cordova build android --release
	jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 -keystore ../copay.keystore -signedjar cordova/project/platforms/android/build/outputs/apk/android-release-signed.apk  cordova/project/platforms/android/build/outputs/apk/android-release-unsigned.apk copay_play 
	zipalign -v 4 cordova/project/platforms/android/build/outputs/apk/android-release-signed.apk cordova/project/platforms/android/build/outputs/apk/android-release-signed-aligned.apk 

android-debug:
	cordova/build.sh ANDROID cosmos --dbgjs
	cd cordova/project && cordova run android

android-debug-fast:
	cordova/build.sh ANDROID cosmos --dbgjs
	cd cordova/project && cordova run android	--device
