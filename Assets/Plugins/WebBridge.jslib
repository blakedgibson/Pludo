mergeInto(LibraryManager.library, {
  SendToApp: function (message) {
    var msgString = UTF8ToString(message);
    // This line sends the message to your React/Expo shell
    window.parent.postMessage(JSON.parse(msgString), "*");
  },
});