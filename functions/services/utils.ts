import { HttpRequest } from "@azure/functions";
import { Buffer } from 'buffer';

export function getCredentials(req: HttpRequest) {

    let username: string | null = null;
    let password: string | null = null;
    let siteUrl: string | null = null;
    let adminKey: string | null = null;

    if (req.headers) {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Basic ')) {
            const base64Credentials = authHeader.split(' ')[1];
            const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
            [username, password] = credentials.split(':');
        }
    }

    if (req.query) {
        console.log("Query: ", req.query);
        siteUrl = req.query.siteURL || null;
        adminKey = req.query.adminkey || null;;
    }


    if (!username || !password || !siteUrl || !adminKey) {
        console.log("Missing required parameters: username, password, siteUrl, or adminKey");
    }

    return { username, password, siteUrl, adminKey };
}