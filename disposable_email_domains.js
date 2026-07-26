// disposable_email_domains.js
// List of known disposable / temporary email domains.
// Used to block signups from throwaway addresses.
// V1 list — covers the most common services. Will be expanded in V2.

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  'tempmail.com', 'tempmail.net', 'tempmail.org', 'temp-mail.com', 'temp-mail.org', 'temp-mail.io',
  'mailinator.com', 'mailinator.net', 'mailinator.org',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', 'spam4.me',
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'throwaway.email', 'throwawaymail.com',
  'getairmail.com', 'getnada.com',
  'dispostable.com', 'maildrop.cc',
  'mailnesia.com', 'mailcatch.com',
  'mohmal.com', 'mintemail.com',
  'mytemp.email', 'tempinbox.com', 'tempr.email', 'discard.email',
  'fake-email.com', 'fakeinbox.com', 'fakemailgenerator.com', 'emailfake.com',
  'tmail.ws', 'tmpmail.org', 'tmpeml.com', 'tmpbox.net',
  'mail-temp.com', 'temporary-mail.net', 'tempemail.co', 'tempemail.net',
  'inboxbear.com', 'mailsac.com', 'spambox.us',
  'mailtothis.com', 'mailtemp.info', 'spamgourmet.com',
  'trashmail.com', 'trashmail.net', 'trashmail.de',
  'easytrashmail.com', 'crazymailing.com',
  'mailbox.in.ua', 'temp-mail.ru', 'mailtrash.net',
  'fakeemail.com', 'tempmailaddress.com',
  'mvrht.net', 'spambog.com', 'wegwerfmail.de',
  'getairmail.net', 'tempinbox.co.uk',
  'eyepaste.com', 'minuteinbox.com',
  'inboxalias.com', 'jetable.org',
  'mt2015.com', 'mt2016.com', 'mt2017.com', 'mt2018.com', 'mt2019.com', 'mt2020.com', 'mt2021.com', 'mt2022.com', 'mt2023.com', 'mt2024.com', 'mt2025.com',
  'safe-mail.net', 'safetymail.info',
  'tempmailo.com', 'tempemails.io',
  'spamex.com', 'spamfree24.org', 'spamhole.com',
  'spambox.org', 'spam.la', 'spamthis.co.uk',
  'meltmail.com', 'mytrashmail.com',
  'sneakemail.com', 'pookmail.com',
  'mailfreeonline.com', 'incognitomail.com',
  'mailexpire.com', 'spamspot.com',
  'noclickemail.com', 'spamavert.com',
  'tempymail.com', 'mail-temp.org',
  'lkfdyazxcv.com', 'whatiaas.com', 'whatpaas.com', 'whatsaas.com'
]);

// Returns true if the email's domain matches a known disposable service.
// Case-insensitive comparison. Handles subdomain attacks (e.g. user@anything.10minutemail.com).
function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  // Catch subdomain attacks — e.g. mail.10minutemail.com
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (DISPOSABLE_EMAIL_DOMAINS.has(candidate)) return true;
  }
  return false;
}

// Export to global scope
if (typeof globalThis !== 'undefined') {
  globalThis.DISPOSABLE_EMAIL_DOMAINS = DISPOSABLE_EMAIL_DOMAINS;
  globalThis.isDisposableEmail = isDisposableEmail;
}

export { DISPOSABLE_EMAIL_DOMAINS, isDisposableEmail };
