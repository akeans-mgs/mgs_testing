import "@babel/polyfill";
import dotenv from "dotenv";
import "isomorphic-fetch";
import createShopifyAuth from "@shopify/koa-shopify-auth";
import { receiveWebhook } from "@shopify/koa-shopify-webhooks";
import Shopify, { ApiVersion } from "@shopify/shopify-api";
import Koa from "koa";

import next from "next";
import Router from "koa-router";

dotenv.config();
const port = parseInt(process.env.PORT, 10) || 8081;
const dev = process.env.NODE_ENV !== "production";
const app = next({
	dev,
});
const handle = app.getRequestHandler();

Shopify.Context.initialize({
	API_KEY: process.env.SHOPIFY_API_KEY,
	API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
	SCOPES: process.env.SCOPES.split(","),
	HOST_NAME: process.env.HOST.replace(/https:\/\/|\/$/g, ""),
	API_VERSION: ApiVersion.October20,
	IS_EMBEDDED_APP: true,
	SESSION_STORAGE: new Shopify.Session.MemorySessionStorage(),
});

// Storing the currently active shops in memory will force them to re-login when your server restarts. You should
// persist this object in your app.
const ACTIVE_SHOPIFY_SHOPS = {};

app.prepare().then(async () => {
	const server = new Koa();
	const router = new Router();

	server.keys = [Shopify.Context.API_SECRET_KEY];

	server.use(
		createShopifyAuth({
			accessMode: "online",
			prefix: "/online",
			async afterAuth(ctx) {
				const { shop } = ctx.state.shopify;
				ctx.redirect(
					`https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`
				);
			},
		})
	);

	server.use(
		createShopifyAuth({
			accessMode: "offline",
			prefix: "/offline",
			async afterAuth(ctx) {
				const { shop, accessToken, scope } = ctx.state.shopify;
				ACTIVE_SHOPIFY_SHOPS[shop] = scope;

				let response = await Shopify.Webhooks.Registry.register({
					shop,
					accessToken,
					path: "/webhooks",
					topic: "APP_UNINSTALLED",
					webhookHandler: async (topic, shop, body) => delete ACTIVE_SHOPIFY_SHOPS[shop],
				});

				if (!response.success) {
					console.log(
						`Failed to register APP_UNINSTALLED webhook: ${response.result}`
					);
				}

				// Redirect to online auth entry point to create
				// an online access mode token that will be used by the embedded app
				ctx.redirect(`/online/auth/?shop=${shop}`);
		  	},
		})
	);

	server.use(
		receiveWebhook({
			path: '/webhook/gdpr/shop_redact',
			secret: process.env.SHOPIFY_API_SECRET || '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',
			onReceived(ctx) {
				console.log("received webhook: ", ctx.state.webhook);
			},
		})
	);

	const handleRequest = async (ctx) => {
		await handle(ctx.req, ctx.res);
		ctx.respond = false;
		ctx.res.statusCode = 200;
	};

	const verifyIfActiveShopifyShop = (ctx, next) => {
		const { shop } = ctx.query;

		// This shop hasn't been seen yet, go through OAuth to create a session
		if (ACTIVE_SHOPIFY_SHOPS[shop] === undefined) {
			ctx.redirect(`/offline/auth?shop=${shop}`);
			return;
		}

		return next();
	};

	router.post("/webhooks", async (ctx) => {
		try {
			await Shopify.Webhooks.Registry.process(ctx.req, ctx.res);
			console.log(`Webhook processed, returned status code 200`);
		} catch (error) {
			console.log(`Failed to process webhook: ${error}`);
		}
	});

	router.get("(/_next/static/.*)", handleRequest); // Static content is clear
	router.get("/_next/webpack-hmr", handleRequest); // Webpack content is clear

	// Embedded app Next.js entry point
	router.get("(.*)", verifyIfActiveShopifyShop, handleRequest);

	server.use(router.allowedMethods());
	server.use(router.routes());

	server.listen(port, () => {
		console.log(`> Ready on http://localhost:${port}`);
	});
});