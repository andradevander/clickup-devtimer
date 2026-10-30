# Connect ClickUp

ClickUp DevTimer talks to ClickUp with your **Personal API Token**.

1. Open ClickUp in your browser.
2. Click your **profile avatar** and choose **Settings**.
3. In the sidebar, open **Apps**.
4. Under **API Token**, click **Generate** (or copy the existing one).
5. Back in VS Code, click **Set Personal Token** and paste it.

The token looks like `pk_12345678_XXXXXXXXXXXXXXXXXXXXXXXX`.

> Your token is stored only in VS Code SecretStorage (your OS keychain) and is sent only to `api.clickup.com`.
