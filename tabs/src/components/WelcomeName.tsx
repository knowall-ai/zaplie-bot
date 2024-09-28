import { useEffect, useState } from "react";
import { useMsal, useAccount } from "@azure/msal-react";
import { Text } from "@fluentui/react";

const WelcomeName = () => {
    const { accounts } = useMsal();
    const account = useAccount(accounts[0] || {});
    const [name, setName] = useState("");

    useEffect(() => {
        if (account && account.name) {
            setName(account.name);
        } else {
            setName("");
        }
    }, [account]);

    if (name) {
        return <Text variant="large">Welcome, {name}</Text>;
    } else {
        return null;
    }
};

export default WelcomeName;