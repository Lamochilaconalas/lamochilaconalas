(function () {
  function normalize(str) {
    return (str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function init() {
    var input = document.getElementById('countrySearch');
    var grid = document.getElementById('countriesGrid');
    var emptyMsg = document.getElementById('countryEmpty');

    if (!input || !grid) return;

    var cards = Array.prototype.slice.call(
      grid.querySelectorAll('.country-card-v2')
    );

    input.addEventListener('input', function () {
      var query = normalize(input.value.trim());
      var visibleCount = 0;

      cards.forEach(function (card) {
        var name = normalize(card.getAttribute('data-name'));
        var matches = query === '' || name.indexOf(query) !== -1;
        card.style.display = matches ? '' : 'none';
        if (matches) visibleCount += 1;
      });

      if (emptyMsg) {
        emptyMsg.style.display =
          query !== '' && visibleCount === 0 ? 'block' : 'none';
      }
    });
  }

  // Si el script tarda en cargar (caché lenta, red móvil, etc.) el evento
  // DOMContentLoaded puede haber disparado ya antes de que esta línea se
  // ejecute. En ese caso el listener de abajo nunca se registraría y el
  // buscador se quedaría inerte sin ningún error en consola.
  // Comprobamos el estado real del documento en vez de asumirlo.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
