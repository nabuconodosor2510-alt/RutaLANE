// REEMPLAZA ESTA URL POR LA DE TU APLICACIÓN WEB DE GOOGLE APPS SCRIPT
const API_URL = 'PEGA_AQUI_TU_URL_DE_APPS_SCRIPT';

const state = {
  config: null,
  ocupacion: {},
  activePinMode: 'origin',
  origin: null,
  dest: null,
  routeLine: null,
  distanceKm: 0,
  tarifa: 0,
  selectedTurno: null
};

let map = null;
let originMarker = null;
let destMarker = null;

document.addEventListener('DOMContentLoaded', initApp);

async function fetchMobileSafe(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function initApp() {
  bindEvents();
  try {
    const res = await fetchMobileSafe(API_URL, {
      method: 'GET',
      cache: 'no-store'
    }, 12000);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.status !== 'ok') {
      throw new Error(data.message || 'No se pudo cargar la configuración.');
    }

    state.config = data.config;
    state.ocupacion = data.ocupacion || {};

    document.getElementById('globalLoader').classList.add('hidden');
    renderBusinessStatus();

    if (state.config.estadoNegocio !== 'ABIERTO') {
      document.getElementById('closedScreen').classList.remove('hidden');
      return;
    }

    document.getElementById('wizardApp').classList.remove('hidden');
    setupDateInput();
    renderTurnos();
  } catch (err) {
    const detail = err.name === 'AbortError'
      ? 'La conexión tardó demasiado en responder en el dispositivo.'
      : err.message;

    document.getElementById('globalLoader').innerHTML = `
      <p class="error-text" style="margin-bottom:12px;">Error al conectar con el servidor: ${detail}</p>
      <button type="button" class="btn btn-primary" onclick="location.reload()">Reintentar</button>
    `;
  }
}

function renderBusinessStatus() {
  const badge = document.getElementById('statusBadge');
  const isOpen = state.config && state.config.estadoNegocio === 'ABIERTO';
  badge.textContent = isOpen ? 'ABIERTO' : 'CERRADO';
  badge.className = `status-badge ${isOpen ? 'status-open' : 'status-closed'}`;
}

function bindEvents() {
  document.getElementById('btnStart').addEventListener('click', () => {
    goToStep(2);
    initMapIfNeeded();
  });

  document.getElementById('btnSelectOrigin').addEventListener('click', () => {
    state.activePinMode = 'origin';
    document.getElementById('btnSelectOrigin').classList.add('active');
    document.getElementById('btnSelectDest').classList.remove('active');
  });

  document.getElementById('btnSelectDest').addEventListener('click', () => {
    state.activePinMode = 'dest';
    document.getElementById('btnSelectDest').classList.add('active');
    document.getElementById('btnSelectOrigin').classList.remove('active');
  });

  document.getElementById('btnToStep3').addEventListener('click', () => {
    document.getElementById('summaryDist').textContent = `${state.distanceKm.toFixed(1)} km`;
    document.getElementById('summaryPrice').textContent = `S/ ${state.tarifa.toFixed(2)}`;
    goToStep(3);
  });

  document.getElementById('fechaProgramada').addEventListener('change', validateDateAndCupos);
  document.getElementById('btnToStep4').addEventListener('click', () => goToStep(4));
  document.getElementById('btnConfirmarPedido').addEventListener('click', submitOrder);
}

function goToStep(stepNumber) {
  document.querySelectorAll('.step-panel').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`step${stepNumber}`).classList.remove('hidden');

  document.querySelectorAll('.stepper .step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s <= stepNumber);
  });

  if (stepNumber === 2 && map) {
    setTimeout(() => map.invalidateSize(), 150);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initMapIfNeeded() {
  if (map) return;

  map = L.map('map').setView([-12.0464, -77.0428], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(map);

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    const label = await reverseGeocode(lat, lng);

    if (state.activePinMode === 'origin') {
      state.origin = { lat, lng, label };
      if (originMarker) map.removeLayer(originMarker);
      originMarker = L.marker([lat, lng]).addTo(map).bindPopup('Origen').openPopup();
      document.getElementById('originLabel').textContent = label;
    } else {
      state.dest = { lat, lng, label };
      if (destMarker) map.removeLayer(destMarker);
      destMarker = L.marker([lat, lng]).addTo(map).bindPopup('Destino').openPopup();
      document.getElementById('destLabel').textContent = label;
    }

    if (state.origin && state.dest) {
      await calculateRouteAndPrice();
    }
  });
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    const d = await r.json();
    return d.display_name ? d.display_name.split(',').slice(0, 3).join(',') : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

async function calculateRouteAndPrice() {
  const loader = document.getElementById('routeLoader');
  const errEl = document.getElementById('routeError');
  const btnNext = document.getElementById('btnToStep3');

  loader.classList.remove('hidden');
  errEl.classList.add('hidden');
  btnNext.disabled = true;

  try {
    const { origin, dest } = state;
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
    const r = await fetch(url);
    const d = await r.json();

    if (!d.routes || !d.routes.length) {
      throw new Error('No se pudo calcular la ruta entre ambos puntos.');
    }

    const route = d.routes[0];
    const distKm = Number((route.distance / 1000).toFixed(1));
    state.distanceKm = distKm;

    const { tarifaBase, kmIncluidos, costoKmExtra } = state.config;
    const extraKm = Math.max(0, distKm - kmIncluidos);
    const total = Number((tarifaBase + extraKm * costoKmExtra).toFixed(2));
    state.tarifa = total;

    if (state.routeLine) {
      map.removeLayer(state.routeLine);
    }
    state.routeLine = L.geoJSON(route.geometry, {
      style: { color: '#0f766e', weight: 5 }
    }).addTo(map);
    map.fitBounds(state.routeLine.getBounds(), { padding: [30, 30] });

    document.getElementById('distanceText').textContent = `${distKm.toFixed(1)} km`;
    document.getElementById('priceText').textContent = `S/ ${total.toFixed(2)}`;
    document.getElementById('routeMetrics').classList.remove('hidden');
    btnNext.disabled = false;
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    loader.classList.add('hidden');
  }
}

function getTomorrowISO() {
  const now = new Date();
  now.setDate(now.getDate() + 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setupDateInput() {
  const input = document.getElementById('fechaProgramada');
  const minDate = getTomorrowISO();
  input.min = minDate;
  input.value = minDate;
  validateDateAndCupos();
}

function validateDateAndCupos() {
  const input = document.getElementById('fechaProgramada');
  const dateErr = document.getElementById('dateError');
  const cupoInfo = document.getElementById('cupoInfo');
  const minDate = getTomorrowISO();
  const chosen = input.value;

  dateErr.classList.add('hidden');

  if (!chosen || chosen < minDate) {
    dateErr.textContent = 'Solo puedes programar envíos desde mañana en adelante.';
    dateErr.classList.remove('hidden');
    cupoInfo.textContent = '';
    updateStep3Button();
    return;
  }

  const ocupados = state.ocupacion[chosen] || 0;
  const limite = state.config.limiteDiario;
  const disponibles = Math.max(0, limite - ocupados);

  if (disponibles <= 0) {
    dateErr.textContent = 'Cupos llenos para esta fecha. Elige otro día disponible.';
    dateErr.classList.remove('hidden');
    cupoInfo.textContent = `Ocupación: ${ocupados}/${limite} pedidos.`;
  } else {
    cupoInfo.textContent = `Cupos disponibles para esta fecha: ${disponibles} de ${limite}.`;
  }

  updateStep3Button();
}

function renderTurnos() {
  const container = document.getElementById('turnosContainer');
  const turnoErr = document.getElementById('turnoError');
  container.innerHTML = '';
  state.selectedTurno = null;

  const turnos = state.config.turnos || [];
  if (!turnos.length) {
    turnoErr.textContent = 'No hay turnos activos en este momento.';
    turnoErr.classList.remove('hidden');
    updateStep3Button();
    return;
  }

  turnoErr.classList.add('hidden');
  turnos.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'turno-card';
    card.innerHTML = `
      <div>
        <strong>${t.nombre}</strong>
        <div class="muted">${t.horario}</div>
      </div>
      <span>Elegir</span>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.turno-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      state.selectedTurno = t;
      updateStep3Button();
    });

    if (idx === 0) {
      card.click();
    }
    container.appendChild(card);
  });

  updateStep3Button();
}

function updateStep3Button() {
  const chosen = document.getElementById('fechaProgramada').value;
  const minDate = getTomorrowISO();
  const ocupados = state.ocupacion[chosen] || 0;
  const hayCupo = ocupados < state.config.limiteDiario;
  const fechaValida = Boolean(chosen && chosen >= minDate && hayCupo);
  const turnoValido = Boolean(state.selectedTurno);

  document.getElementById('btnToStep4').disabled = !(fechaValida && turnoValido);
}

async function submitOrder() {
  const submitErr = document.getElementById('submitError');
  const loader = document.getElementById('submitLoader');
  const btn = document.getElementById('btnConfirmarPedido');

  submitErr.classList.add('hidden');

  const remitenteNombre = document.getElementById('remitenteNombre').value.trim();
  const remitenteTelefono = document.getElementById('remitenteTelefono').value.trim();
  const destinatarioNombre = document.getElementById('destinatarioNombre').value.trim();
  const destinatarioTelefono = document.getElementById('destinatarioTelefono').value.trim();
  const referencias = document.getElementById('referencias').value.trim();
  const checkBulto = document.getElementById('checkBulto').checked;
  const fechaProgramada = document.getElementById('fechaProgramada').value;

  if (!remitenteNombre || !remitenteTelefono || !destinatarioNombre || !destinatarioTelefono) {
    submitErr.textContent = 'Completa todos los campos obligatorios de remitente y destinatario.';
    submitErr.classList.remove('hidden');
    return;
  }

  if (!checkBulto) {
    submitErr.textContent = 'Debes confirmar que el envío es de 1 solo bulto apto para motocicleta.';
    submitErr.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  loader.classList.remove('hidden');

  const payload = {
    fechaProgramada,
    turnoRecojo: `${state.selectedTurno.nombre} (${state.selectedTurno.horario})`,
    remitenteNombre,
    remitenteTelefono,
    destinatarioNombre,
    destinatarioTelefono,
    direccionOrigen: state.origin.label,
    direccionDestino: state.dest.label,
    referencias: referencias || 'Sin referencias',
    distanciaKm: state.distanceKm,
    tarifa: state.tarifa
  };

  try {
    const res = await fetchMobileSafe(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }, 15000);

    const result = await res.json();

    if (result.status !== 'ok') {
      throw new Error(result.message || 'No se pudo registrar el pedido.');
    }

    const msg = [
      `🏍️ *NUEVO PEDIDO RUTALANE (${result.idPedido})*`,
      `📅 *Fecha:* ${fechaProgramada}`,
      `⏰ *Turno Recojo:* ${payload.turnoRecojo}`,
      `🚚 *Entrega:* Dentro del mismo día del recojo`,
      `👤 *Remitente:* ${remitenteNombre} (${remitenteTelefono})`,
      `📦 *Destinatario:* ${destinatarioNombre} (${destinatarioTelefono})`,
      `📍 *Origen:* ${payload.direccionOrigen}`,
      `🏁 *Destino:* ${payload.direccionDestino}`,
      `📝 *Referencias:* ${payload.referencias}`,
      `📏 *Distancia:* ${payload.distanciaKm.toFixed(1)} km`,
      `💰 *Tarifa:* S/ ${payload.tarifa.toFixed(2)}`,
      `✅ *Condición:* 1 bulto para moto`
    ].join('\n');

    const waUrl = `https://wa.me/${state.config.whatsapp}?text=${encodeURIComponent(msg)}`;
    document.getElementById('createdOrderId').textContent = result.idPedido;
    document.getElementById('manualWhatsappLink').href = waUrl;

    document.querySelectorAll('.step-panel').forEach((el) => el.classList.add('hidden'));
    document.getElementById('stepSuccess').classList.remove('hidden');

    window.location.href = waUrl;
  } catch (err) {
    submitErr.textContent = err.name === 'AbortError'
      ? 'La solicitud tardó demasiado. Intenta nuevamente.'
      : err.message;
    submitErr.classList.remove('hidden');
    btn.disabled = false;
  } finally {
    loader.classList.add('hidden');
  }
}
