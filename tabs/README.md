# Getting Started with Zaplie React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Proxy

To resolve the CORS blocking issue, we setup a proxy. This is done by `setupProxy.js` which is dependent on running:

```
npm install http-proxy-middleware@2.0.6
```

NB We install version `2.0.6` because that is the version used by `webpack-dev-server` (a dependency of `react-scripts`). You can check you only have one version of `http-proxy-middle@2.0.6` is installed by running:

```
npm ls http-proxy-middleware
```

## SSO Authentication

For the SSO authentication function to work, obtain the MS Bot Framework ID saved in the Environment variables.
1. Update the enviroment variables with the Bot CLient ID and with your Tenant ID
2. Navigate to https:portal.azure.com and search for App Registration
3. Search for the Bot App regristation using the client ID used in your environment variables.
4. Under Manage, select Authentication.
5. Under Platform configurations , click **Add a platform**
6. Select Single-page application
in the URL Redirect add http://localhost:{portnumber} in this instance it was 3000
7. Under Advance setting on the same page, **Allow public client flows**
8. Now save the changes


## Available Scripts

In the `/tabs` directory, you can run:

```
npm install
npm start
```

This runs the app in the development mode and will create necessary symbolic links (to lnbitsService.ts)

Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.

You may also see any lint errors in the console.

### Testing

To run the app in the interactive watch mode, run:

`npm test`

See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### Deploying

Run the following command:

`npm run build`

This builds the app for production to the `build` folder. It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes. Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.
