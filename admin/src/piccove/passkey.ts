import { api } from './api';

export function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}
export function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
type Descriptor = {
  id: string;
  type: 'public-key';
  transports?: AuthenticatorTransport[];
};
type Options = {
  rp: PublicKeyCredentialRpEntity;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  challenge: string;
  user?: { id: string; name: string; displayName: string };
  excludeCredentials?: Descriptor[];
  allowCredentials?: Descriptor[];
};
export async function passkey(register: boolean, body: unknown) {
  if (!window.isSecureContext || !window.PublicKeyCredential)
    throw new Error('此浏览器不支持 Passkey，请使用 HTTPS 和支持的浏览器');
  const path = register ? '/me/passkeys' : '/auth/passkey';
  const { id, options } = await api<{
    id: string;
    options: { publicKey: Options };
  }>(`${path}/start`, 'POST', body);
  const value = options.publicKey;
  const publicKey = {
    ...value,
    challenge: decode(value.challenge),
    ...(value.user && { user: { ...value.user, id: decode(value.user.id) } }),
    ...(value.excludeCredentials && {
      excludeCredentials: value.excludeCredentials.map((key) => ({
        ...key,
        id: decode(key.id),
      })),
    }),
    ...(value.allowCredentials && {
      allowCredentials: value.allowCredentials.map((key) => ({
        ...key,
        id: decode(key.id),
      })),
    }),
  };
  const credential = (
    register
      ? await navigator.credentials.create({
          publicKey: publicKey as PublicKeyCredentialCreationOptions,
        })
      : await navigator.credentials.get({
          publicKey: publicKey as PublicKeyCredentialRequestOptions,
        })
  ) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey 验证已取消');
  const response = credential.response;
  const data =
    response instanceof AuthenticatorAttestationResponse
      ? {
          clientDataJSON: encode(response.clientDataJSON),
          attestationObject: encode(response.attestationObject),
          transports: response.getTransports(),
        }
      : {
          clientDataJSON: encode(response.clientDataJSON),
          authenticatorData: encode(
            (response as AuthenticatorAssertionResponse).authenticatorData,
          ),
          signature: encode(
            (response as AuthenticatorAssertionResponse).signature,
          ),
          userHandle: (response as AuthenticatorAssertionResponse).userHandle
            ? encode((response as AuthenticatorAssertionResponse).userHandle!)
            : null,
        };
  await api(`${path}/finish`, 'POST', {
    id,
    credential: {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      response: data,
      extensions: credential.getClientExtensionResults(),
    },
  });
}
