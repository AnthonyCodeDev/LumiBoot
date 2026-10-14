import { useEffect, useMemo, useState } from 'react';
import { validateRelayUrl } from '@lumiboot/vm-network';
import { Button } from '../ui/Button';
import { useNetworkStore } from '../../features/settings/network.store';
import { useSessionsStore } from '../../features/sessions/sessions.store';
import { formatSessionBytes } from '../session/statusOverlay.helpers';
import {
  BROWSER_FETCH_NOTICE,
  NETWORK_MODE_OPTIONS,
  buildCapabilityRows,
  capabilitiesFor,
  networkModeLabel,
  networkStatusLabel,
  pickActiveNetworkDiagnostics,
} from './networkPanel.helpers';

const RELAY_INPUT_ID = 'network-relay-url';
const RELAY_ERROR_ID = 'network-relay-error';

export function NetworkPanel() {
  const profile = useNetworkStore((state) => state.profile);
  const setMode = useNetworkStore((state) => state.setMode);
  const setRelayUrl = useNetworkStore((state) => state.setRelayUrl);
  const sessions = useSessionsStore((state) => state.sessions);

  const [relayInput, setRelayInput] = useState(profile.relayUrl ?? '');

  // Le champ reflète la valeur persistée ; une saisie invalide reste locale
  // (elle n'écrase jamais l'adresse enregistrée).
  useEffect(() => {
    setRelayInput(profile.relayUrl ?? '');
  }, [profile.relayUrl, profile.mode]);

  const validation = useMemo(() => validateRelayUrl(relayInput), [relayInput]);
  const trimmedInput = relayInput.trim();
  const hasInput = trimmedInput.length > 0;
  const capabilityRows = buildCapabilityRows(capabilitiesFor(profile.mode));
  const isBrowserFetch = profile.mode === 'browser-fetch';
  const diagnostics = pickActiveNetworkDiagnostics(sessions);
  const canSaveRelay = validation.ok && validation.url !== profile.relayUrl;

  return (
    <section className="network-panel" aria-labelledby="network-panel-title">
      <header className="network-panel-header">
        <h2 id="network-panel-title">Réseau</h2>
        <p>
          Choisissez comment les systèmes invités accèdent au réseau. Aucun relais public n&apos;est
          utilisé par défaut : en mode relais, seule l&apos;adresse que vous fournissez est employée.
        </p>
      </header>

      <p className="network-restart-notice" role="note">
        Le mode réseau est figé au démarrage : le changer <strong>nécessite un redémarrage</strong>{' '}
        de la session en cours. Il s&apos;appliquera aux prochaines sessions.
      </p>

      <fieldset className="network-modes">
        <legend>Mode réseau</legend>
        {NETWORK_MODE_OPTIONS.map((option) => (
          <label
            key={option.id}
            className="network-mode"
            data-planned={option.planned || undefined}
          >
            <input
              type="radio"
              name="network-mode"
              value={option.id}
              checked={profile.mode === option.id}
              disabled={option.planned}
              onChange={() => setMode(option.id)}
            />
            <span className="network-mode-body">
              <span className="network-mode-label">
                {option.label}
                {option.planned ? <span className="network-mode-badge">Bientôt disponible</span> : null}
              </span>
              <span className="network-mode-description">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {profile.mode === 'user-relay' ? (
        <div className="network-relay">
          <label className="network-field-label" htmlFor={RELAY_INPUT_ID}>
            Adresse du relais WISP
          </label>
          <div className="network-field-row">
            <input
              id={RELAY_INPUT_ID}
              className="network-field-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="wss://relay.example:4000"
              value={relayInput}
              aria-invalid={hasInput && !validation.ok}
              aria-describedby={hasInput && !validation.ok ? RELAY_ERROR_ID : undefined}
              onChange={(event) => setRelayInput(event.target.value)}
            />
            <Button
              variant="outline"
              type="button"
              disabled={!canSaveRelay}
              onClick={() => setRelayUrl(relayInput)}
            >
              Enregistrer l&apos;adresse
            </Button>
          </div>
          <p className="network-field-help" id="network-relay-help">
            Seul le protocole sécurisé <code>wss://</code> est accepté. Les identifiants dans
            l&apos;URL sont interdits et ne sont jamais enregistrés.
          </p>
          {hasInput ? (
            validation.ok ? (
              <p className="network-field-status" data-tone="success" role="status">
                Adresse de relais valide{canSaveRelay ? ' — cliquez sur « Enregistrer l’adresse ».' : ' et enregistrée.'}
              </p>
            ) : (
              <p className="network-field-status" data-tone="error" role="alert" id={RELAY_ERROR_ID}>
                {validation.error}
              </p>
            )
          ) : (
            <p className="network-field-status" data-tone="muted" role="status">
              Aucune adresse de relais enregistrée : ce mode reste inactif tant qu&apos;elle est
              absente.
            </p>
          )}
        </div>
      ) : null}

      <section className="network-capabilities" aria-labelledby="network-capabilities-title">
        <h3 id="network-capabilities-title">Capacités offertes à la machine invitée</h3>
        {isBrowserFetch ? (
          <p className="network-cap-notice" data-tone="warning">
            {BROWSER_FETCH_NOTICE}
          </p>
        ) : null}
        {profile.mode === 'offline' ? (
          <p className="network-cap-notice" data-tone="muted">
            Machine totalement isolée : aucune capacité réseau n&apos;est disponible.
          </p>
        ) : null}
        <ul className="network-cap-list">
          {capabilityRows.map((row) => (
            <li key={row.label} className="network-cap" data-enabled={row.enabled}>
              <span className="network-cap-mark" aria-hidden="true">
                {row.enabled ? '✓' : '✕'}
              </span>
              <span className="network-cap-label">{row.label}</span>
              <span className="network-cap-state">
                {row.enabled ? 'Disponible' : 'Indisponible'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="network-diagnostics"
        aria-labelledby="network-diagnostics-title"
        aria-live="polite"
      >
        <h3 id="network-diagnostics-title">Diagnostic de la session</h3>
        {diagnostics ? (
          <dl className="network-diagnostics-grid">
            <div>
              <dt>Mode actif</dt>
              <dd>{networkModeLabel(diagnostics.mode)}</dd>
            </div>
            <div>
              <dt>Statut</dt>
              <dd data-tone={diagnostics.status}>{networkStatusLabel(diagnostics.status)}</dd>
            </div>
            <div>
              <dt>Émis (tx)</dt>
              <dd>{formatSessionBytes(diagnostics.txBytes)}</dd>
            </div>
            <div>
              <dt>Reçu (rx)</dt>
              <dd>{formatSessionBytes(diagnostics.rxBytes)}</dd>
            </div>
            {diagnostics.lastError ? (
              <div className="network-diagnostics-error">
                <dt>Dernière erreur</dt>
                <dd>
                  <code>{diagnostics.lastError.code}</code> {diagnostics.lastError.message}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="network-diagnostics-empty">
            Aucune session active — le réseau s&apos;applique au prochain démarrage.
          </p>
        )}
      </section>
    </section>
  );
}
