var expanded = false;

function updateDisplay(query) {
  var q = (query || '').trim().toLowerCase();
  var cards = document.querySelectorAll('#countriesGrid .country-card-v2');
  var visibleCount = 0;
  cards.forEach(function(card) {
    var name = card.getAttribute('data-name') || '';
    var isExtra = card.classList.contains('extra');
    var matches = q === '' ? true : name.indexOf(q) !== -1;
    var shouldShow;
    if (q !== '') {
      shouldShow = matches;
    } else {
      shouldShow = expanded || !isExtra;
    }
    card.style.display = shouldShow ? '' : 'none';
    if (shouldShow) visibleCount++;
  });
  document.getElementById('countryEmpty').style.display = visibleCount === 0 ? 'block' : 'none';
  document.getElementById('verMasWrap').style.display = (q === '' && !expanded) ? 'block' : 'none';
}

function filterCountries(query) {
  updateDisplay(query);
}

function showAllCountries() {
  expanded = true;
  updateDisplay(document.getElementById('countrySearch').value);
}

function initCountryFilters() {
  var searchInput = document.getElementById('countrySearch');
  var verMasBtn = document.getElementById('btnVerMas');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      filterCountries(searchInput.value);
    });
  }
  if (verMasBtn) {
    verMasBtn.addEventListener('click', showAllCountries);
  }
  updateDisplay('');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCountryFilters);
} else {
  initCountryFilters();
}
