import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import { getUsers, getAccessToken, setLnbitUrl } from '../services/lnbitsService';
import { getCredentials } from '../services/utils';

const listUsers: AzureFunction = async function (context: Context, req: HttpRequest): Promise<void> {
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

        const accessToken = await getAccessToken(req, username, password);
        const users = await getUsers(req,adminKey, { filterByExtra: null });
        let filteredUsers = users;


            context.res = {
                body: JSON.stringify(filteredUsers || [])
            };
        
    } catch (error) {
        context.res = {
            status: 500,
            body: `Error: ${error.message}`
        };
    }
};

export default listUsers;