import { SettingsRow, ExternalLink } from "@getpaseo/plugin/client/ui";

export function ErrorMessage({ message }: { message: string }) {
  const link = message.match(/https:\/\/[^\s"'<>]+/)?.[0];
  return <SettingsRow label={message}>{link && <ExternalLink href={link}>Open verification link</ExternalLink>}</SettingsRow>;
}
