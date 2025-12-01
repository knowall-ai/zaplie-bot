import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import { getAccessToken, setLnbitUrl } from '../services/lnbitsService';
import { getCredentials } from '../services/utils';

const showUsers: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
    context.log('Getting Users from LNBits');

    // Log all headers
    context.log("Headers:", req.headers);

    try {
        // Extract credentials from the request
        const { username, password, siteUrl, adminKey } = getCredentials(req);

        if (!username || !password || !siteUrl || !adminKey) {
            context.res = {
                status: 400,
                body: "Missing required parameters: username, password, siteUrl, or adminKey"
            };
            return;
        }

        // Set the lnbiturl
        setLnbitUrl(req);

        // Get access token
        const accessToken = await getAccessToken(req, username, password);
        context.log('Access Token:', accessToken);

        // Get users
        const users = await getUsers(req, adminKey,siteUrl);
        context.log('Users:', users);
        context.res = {status:200 , body:JSON.stringify(users)};

    } catch (error) {
        context.log('Error:', error);
        context.res = {
            status: 500,
            body: `Error: ${error.message}`
        };
    }
};

// Note: LNbits v1+ core API doesn't provide user listing with custom metadata.
// User management with custom metadata must be handled at the application layer.
// This function is deprecated and should be replaced with application-level user management.
const getUsers = async (
    req: HttpRequest,
    adminKey: string,
    lnbiturl: string
): Promise<any> => {
    console.log(`getUsers starting ... (adminKey: ${adminKey})`);

    console.log(`LNBits URL: ${lnbiturl}`);

    // LNbits v1+ core API doesn't support user listing with custom metadata
    // This functionality must be implemented at the application layer
    throw new Error(
        'getUsers is not supported by LNbits v1+ core API. Implement user management at application layer.',
    );
};

export default showUsers;