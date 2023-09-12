export default {
	name: [
		(v: string) => !!v || 'Enter display name',
		(v: string) => (v && v.length >= 2 && v.length <= 16) || 'Display name should be from 2 to 32 characters',
	],
	firstname: [
		(v: string) => !!v || 'Enter firstname',
		(v: string) => (v && v.length >= 2 && v.length <= 16) || 'Firstname should be from 2 to 32 characters',
	],
	lastname: [
		(v: string) => !!v || 'Enter lastname',
		(v: string) => (v && v.length >= 2 && v.length <= 16) || 'Lastname should be from 2 to 32 characters',
	],
	email: [(v: string) => !!v || 'Enter email', (v: string) => /.+@.+\..+/.test(v) || 'Введите корректную почту'],
	terms: [(v: string) => !!v || 'You should agree with rules'],
	password: [
		(v: string) => !!v || 'Enter password',
		(v: string) => (v && v.length >= 6 && v.length <= 32) || 'Password should be from 6 to 32 characters',
	],
	file: [
		(v: FileList | File[]) => (v.length ? v[0].size <= 2097152 || 'File size size should be less than 2 mib' : true),
	],
};
