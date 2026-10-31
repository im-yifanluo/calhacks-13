import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export function s3PasswordStore(client, bucket) {
  return {
    async read(key) {
      try {
        const value = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { value: await value.Body.transformToString(), version: value.ETag };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async write(key, value, version) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: value,
            ContentType: "application/octet-stream",
            CacheControl: "no-store",
            ...(version ? { IfMatch: version } : { IfNoneMatch: "*" }),
          }),
        );
        return true;
      } catch (error) {
        if ([409, 412].includes(error?.$metadata?.httpStatusCode)) return false;
        if ([429, 503].includes(error?.$metadata?.httpStatusCode)) {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return false;
        }
        throw error;
      }
    },
  };
}
