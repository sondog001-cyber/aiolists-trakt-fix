const fs = require('fs');

function replaceOnce(file, search, replacement) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(search)) throw new Error(`Patch target not found in ${file}: ${search.slice(0,120)}`);
  fs.writeFileSync(file, text.replace(search, replacement));
}

const traktFile = '/usr/src/app/src/integrations/trakt.js';
const apiFile = '/usr/src/app/src/routes/api.js';
const scriptFile = '/usr/src/app/public/script.js';

// 1) Add Trakt Device Code helpers.
replaceOnce(
  traktFile,
  "async function authenticateTrakt(code, userConfig) {",
  `async function startTraktDeviceAuth() {
  const response = await axios.post('https://api.trakt.tv/oauth/device/code', {
    client_id: TRAKT_CLIENT_ID
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });

  return response.data;
}

async function pollTraktDeviceAuth(deviceCode) {
  try {
    const response = await axios.post('https://api.trakt.tv/oauth/device/token', {
      code: deviceCode,
      client_id: TRAKT_CLIENT_ID
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
      validateStatus: () => true
    });

    if (response.status === 200) {
      const tokens = {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresAt: Date.now() + (response.data.expires_in * 1000)
      };
      const userSettings = await getTraktUserSettings(tokens.accessToken);
      return {
        status: 'authorized',
        uuid: userSettings.uuid,
        username: userSettings.username,
        ...tokens
      };
    }

    if (response.status === 400) return { status: 'pending' };
    if (response.status === 404) return { status: 'invalid' };
    if (response.status === 409) return { status: 'used' };
    if (response.status === 410) return { status: 'expired' };
    if (response.status === 418) return { status: 'denied' };
    if (response.status === 429) return { status: 'slow_down' };

    return {
      status: 'error',
      httpStatus: response.status,
      details: response.data
    };
  } catch (error) {
    return { status: 'error', details: error.message };
  }
}

async function authenticateTrakt(code, userConfig) {`
);

replaceOnce(
  traktFile,
  "  authenticateTrakt,\n",
  "  authenticateTrakt,\n  startTraktDeviceAuth,\n  pollTraktDeviceAuth,\n"
);

// 2) Import helpers into API routes.
replaceOnce(
  apiFile,
  "const { initTraktApi, authenticateTrakt, getTraktAuthUrl, fetchTraktLists, fetchPublicTraktListDetails, validateTraktApi } = require('../integrations/trakt');",
  "const { initTraktApi, authenticateTrakt, startTraktDeviceAuth, pollTraktDeviceAuth, getTraktAuthUrl, fetchTraktLists, fetchPublicTraktListDetails, validateTraktApi } = require('../integrations/trakt');"
);

// 3) Make Render-provided Upstash env vars the default persistence credentials.
replaceOnce(
  apiFile,
  "      req.userConfig = await decompressConfig(configHash);\n      req.configHash = configHash;",
  `      req.userConfig = await decompressConfig(configHash);
      req.configHash = configHash;

      if (!req.userConfig.upstashUrl && process.env.UPSTASH_REDIS_REST_URL) {
        req.userConfig.upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
      }
      if (!req.userConfig.upstashToken && process.env.UPSTASH_REDIS_REST_TOKEN) {
        req.userConfig.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      }`
);

// 4) Add Device Code endpoints before old PIN auth route.
replaceOnce(
  apiFile,
  "  router.post('/:configHash/trakt/auth', async (req, res) => {",
  `  router.post('/:configHash/trakt/device/start', async (req, res) => {
    try {
      const device = await startTraktDeviceAuth();
      res.json({ success: true, ...device });
    } catch (error) {
      console.error('Error starting Trakt device auth:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to start Trakt device authorization' });
    }
  });

  router.post('/:configHash/trakt/device/poll', async (req, res) => {
    try {
      const { deviceCode } = req.body;
      if (!deviceCode) return res.status(400).json({ error: 'Device code is required' });

      const result = await pollTraktDeviceAuth(deviceCode);
      if (result.status !== 'authorized') {
        return res.status(result.status === 'pending' || result.status === 'slow_down' ? 202 : 400)
          .json({ success: false, status: result.status, details: result.details || null });
      }

      const userConfig = req.userConfig;
      userConfig.traktAccessToken = result.accessToken;
      userConfig.traktRefreshToken = result.refreshToken;
      userConfig.traktExpiresAt = result.expiresAt;
      userConfig.traktUuid = result.uuid;
      userConfig.traktUsername = result.username;

      if (userConfig.upstashUrl && userConfig.upstashToken && userConfig.traktUuid) {
        await saveTraktTokens(userConfig, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt
        });
      }

      const newConfigHash = await compressConfig(createConfigForStorage(userConfig));
      res.json({
        success: true,
        status: 'authorized',
        configHash: newConfigHash,
        uuid: result.uuid,
        username: result.username,
        persistent: !!(userConfig.upstashUrl && userConfig.upstashToken)
      });
    } catch (error) {
      console.error('Error polling Trakt device auth:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to complete Trakt device authorization' });
    }
  });

  router.post('/:configHash/trakt/auth', async (req, res) => {`
);

// 5) Replace Connect button behavior with Device Code Flow.
const oldLogin = `    // Trakt login button click handler
    elements.traktLoginBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      try {
        if (!state.configHash) {
          showNotification('connections', 'Please wait for configuration to load', 'error');
          return;
        }
        
        // First, check the server to determine if we need PIN flow or redirect flow
        const response = await fetch(\`/\${state.configHash}/trakt/login\`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(\`Server error: \${response.status}\`);
        }
        
        const data = await response.json();
        
        if (data.requiresManualAuth) {
          // PIN flow - open in new tab and show PIN input
          const newTab = window.open(data.authUrl, '_blank');
          if (!newTab) {
            showNotification('connections', 'Please allow popups or manually visit the Trakt authorization page', 'warning');
          } else {
            showNotification('connections', 'Please authorize the app in the new tab and enter the PIN below', 'info');
          }
          
          // Show PIN input container
          elements.traktLoginBtn.style.setProperty('display', 'none', 'important');
          elements.traktPinContainer.style.setProperty('display', 'flex', 'important');
          elements.traktPin.focus();
          
        } else {
          // Redirect flow - redirect directly
          showNotification('connections', 'Redirecting to Trakt for authorization...', 'info');
          window.location.href = data.authUrl;
        }
        
      } catch (error) {
        console.error('Trakt Login Error:', error);
        showNotification('connections', \`Trakt Login Error: \${error.message}\`, 'error', true);
      }
    });`;

const newLogin = `    // Trakt Device Code login flow
    elements.traktLoginBtn.addEventListener('click', async function(e) {
      e.preventDefault();
      if (!state.configHash) {
        showNotification('connections', 'Please wait for configuration to load', 'error');
        return;
      }

      // Open synchronously so popup blockers do not swallow the verification page.
      const authWindow = window.open('about:blank', '_blank');

      try {
        const response = await fetch(\`/\${state.configHash}/trakt/device/start\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Failed to start Trakt authorization');

        elements.traktLoginBtn.style.setProperty('display', 'none', 'important');
        elements.traktPinContainer.style.setProperty('display', 'flex', 'important');
        elements.traktPin.value = data.user_code || '';
        elements.traktPin.readOnly = true;
        elements.traktPin.dataset.deviceCode = data.device_code;
        elements.traktPin.dataset.expiresAt = String(Date.now() + ((data.expires_in || 600) * 1000));
        elements.submitTraktPin.querySelector('b').textContent = 'Check Authorization';

        if (authWindow) {
          authWindow.location.href = data.verification_url;
        } else {
          await navigator.clipboard?.writeText(data.user_code || '');
        }

        showNotification(
          'connections',
          \`Enter code \${data.user_code} at \${data.verification_url}. This page will check automatically.\`,
          'info',
          true
        );

        const intervalMs = Math.max((data.interval || 5) * 1000, 5000);
        const poll = async () => {
          if (!elements.traktPin.dataset.deviceCode) return;
          if (Date.now() >= Number(elements.traktPin.dataset.expiresAt || 0)) {
            elements.traktPin.dataset.deviceCode = '';
            showNotification('connections', 'Trakt authorization expired. Click Connect to Trakt and try again.', 'error', true);
            return;
          }
          const done = await handleTraktPinSubmit(true);
          if (!done && elements.traktPin.dataset.deviceCode) {
            setTimeout(poll, intervalMs);
          }
        };
        setTimeout(poll, intervalMs);
      } catch (error) {
        if (authWindow && !authWindow.closed) authWindow.close();
        console.error('Trakt Device Login Error:', error);
        showNotification('connections', \`Trakt Login Error: \${error.message}\`, 'error', true);
      }
    });`;

replaceOnce(scriptFile, oldLogin, newLogin);

// 6) Repurpose old PIN submit handler as Device Code poll.
const oldSubmit = `  async function handleTraktPinSubmit() {
    const pin = elements.traktPin.value.trim();
    if (!pin) return showNotification('connections', 'Please enter your Trakt PIN', 'error');
    try {
      const response = await fetch(\`/\${state.configHash}/trakt/auth\`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ code: pin }) 
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || data.details || 'Trakt auth failed');
      }

      if (data.configHash) {
          state.configHash = data.configHash;
          
                updateURL();
      updateStremioButtonHref();
      
      showNotification('connections', \`Successfully connected to Trakt as \${data.username || 'user'}!\`, 'success');
      await loadConfiguration(); 
      } else {
          throw new Error("Received success from server but no new config hash.");
      }
      
    } catch (error) { 
      console.error('Trakt Error:', error); 
      showNotification('connections', \`Trakt Error: \${error.message}\`, 'error', true);
      // Hide PIN container on error, keep login button visible
      elements.traktPinContainer.style.setProperty('display', 'none', 'important');
      elements.traktPin.value = ''; // Clear the PIN field
    }
  }`;

const newSubmit = `  async function handleTraktPinSubmit(silentPending = false) {
    const deviceCode = elements.traktPin.dataset.deviceCode;
    if (!deviceCode) {
      if (!silentPending) showNotification('connections', 'Start Trakt authorization first.', 'error');
      return false;
    }

    try {
      const response = await fetch(\`/\${state.configHash}/trakt/device/poll\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode })
      });
      const data = await response.json();

      if (response.status === 202) {
        if (!silentPending) showNotification('connections', 'Still waiting for Trakt authorization...', 'info');
        return false;
      }

      if (!response.ok || !data.success) {
        const terminal = ['expired', 'denied', 'invalid', 'used'].includes(data.status);
        if (terminal) elements.traktPin.dataset.deviceCode = '';
        throw new Error(data.status || data.error || 'Trakt authorization failed');
      }

      state.configHash = data.configHash;
      elements.traktPin.dataset.deviceCode = '';
      elements.traktPin.readOnly = false;
      elements.traktPin.value = '';
      updateURL();
      updateStremioButtonHref();
      showNotification(
        'connections',
        \`Successfully connected to Trakt as \${data.username || 'user'}!\${data.persistent ? ' Persistence is enabled.' : ''}\`,
        'success',
        true
      );
      await loadConfiguration();
      return true;
    } catch (error) {
      console.error('Trakt Device Auth Error:', error);
      if (!silentPending) showNotification('connections', \`Trakt Error: \${error.message}\`, 'error', true);
      return false;
    }
  }`;

replaceOnce(scriptFile, oldSubmit, newSubmit);

// Clean cancel behavior for device flow.
replaceOnce(
  scriptFile,
  "    elements.traktPin.value = '';\n    showNotification('connections', 'Trakt authentication cancelled', 'info');",
  "    elements.traktPin.value = '';\n    elements.traktPin.readOnly = false;\n    elements.traktPin.dataset.deviceCode = '';\n    showNotification('connections', 'Trakt authentication cancelled', 'info');"
);

console.log('Applied AIOLists Trakt Device Code Flow patch successfully.');
