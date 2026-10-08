/** Optional helper for the host page: resizes the widget iframe to fit its
 *  content so visitors never see a scrollbar inside it. Without this script
 *  the iframe still works at whatever fixed height it is given.
 */
(function () {
  var widgetOrigin = new URL(document.currentScript.src).origin;

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.origin !== widgetOrigin || !data || data.type !== "eloy-council-widget:height") return;
    var height = Number(data.height);
    if (!(height > 0)) return;

    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) {
        frames[i].style.height = Math.ceil(height) + "px";
      }
    }
  });
})();
